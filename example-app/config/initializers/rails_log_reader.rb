# frozen_string_literal: true

# rails-log-reader — the Rails half of it.
#
# Copy this file into config/initializers/, then turn it on for yourself with
#
#     touch log/rails_log_reader.enabled
#
# and restart. Delete that file to turn it off again. Nothing below the gate on the first
# line of code runs without it, so a colleague who never creates one gets no middleware, no
# subscribers, no logger sink and no file at all — their `tail -f log/development.log` shows
# exactly what it shows today. That is why this file being committed is harmless.
#
# Events are appended, one JSON object per line, to log/rails_log_reader.jsonl, which Rails'
# own .gitignore already covers. The Reader tails that file and never writes to it. Nothing
# is ever written into log/development.log except the boot warnings below — and those cannot
# reach a developer who has not opted in, because they sit below the gate too.
#
# The master copy lives at reader/rails/rails_log_reader.rb in the rails-log-reader repo,
# and the Reader diffs this file against it. Edit it there, not here.

# The one gate, and the reason inertness is structural rather than audited: with no marker
# file, or in any environment but development, the rest of this file never happens.
# `development?` is an allowlist — production, staging and test are refused by construction
# rather than by three checks that could each be got wrong. The marker file's *presence* is
# the whole switch; its contents are never read. Both questions are answered once, here, at
# boot, which is why turning the Reader on takes a restart.
return unless Rails.env.development? && Rails.root.join("log/rails_log_reader.enabled").exist?

# ActiveSupport::BroadcastLogger#broadcast_to is the only way to read Rails.logger without
# changing what log/development.log contains, and Rails 7.0 does not have it. Its 7.0
# substitute is deprecated, undocumented and cannot be detached again, so it would break the
# promise this whole file is built around rather than merely cost a port.
if Rails.gem_version < Gem::Version.new("7.1")
  Rails.logger.warn(
    "[rails_log_reader] disabled: reading Rails.logger without changing log/development.log " \
    "needs BroadcastLogger#broadcast_to, which arrived in Rails 7.1. This app is on " \
    "Rails #{Rails.version}."
  )
  return
end

require "json"
require "securerandom"

module RailsLogReader
  # Stamped on every envelope, and bumped when a field changes meaning. The Reader reads it
  # to tell "the new file is loaded" from "the file on disk is new but the process is not".
  WIRE_VERSION = 1

  SIDECAR = Rails.root.join("log/rails_log_reader.jsonl")

  # The disk bound, checked once at boot and never again. Truncating on every boot would
  # fire every time puma-dev reaps an idle app, which is precisely the history worth keeping.
  MAX_SIDECAR_BYTES = 64 * 1024 * 1024

  # A field past this is cut, and its original byte length is recorded under `truncated` so
  # the Reader can say "showing 64KB of 812KB". A backtrace is exempt and kept whole: "the
  # bug was in a gem" has to stay an answer the Reader can give.
  MAX_FIELD_BYTES = 64 * 1024
  KEPT_WHOLE = %w[backtrace].freeze

  @mutex = Mutex.new
  @disabled = false
  @run_pid = nil

  class << self
    # Every Event goes through here, inline on the thread that observed it: one mutex, one
    # write, `sync = true`, no queue and no background thread. A drain thread would need a
    # queue bound, a drop policy and a flush at shutdown — and would lose events exactly at
    # shutdown, which is when they matter most. `seq` is taken under the same lock as the
    # write, so within a Run the numbers and the bytes in the file agree.
    def emit(type, payload, request_id: nil)
      return if @disabled

      at_mono = Process.clock_gettime(Process::CLOCK_MONOTONIC, :nanosecond)
      at_wall = Process.clock_gettime(Process::CLOCK_REALTIME, :millisecond)
      payload, truncated = cut_oversized_fields(payload)

      @mutex.synchronize do
        return if @disabled

        start_run unless @run_pid == Process.pid

        envelope = {
          v: WIRE_VERSION, run_id: @run_id, seq: (@seq += 1),
          at_mono:, at_wall:, request_id:, type:, payload:
        }
        envelope[:truncated] = truncated if truncated

        @sidecar.write("#{JSON.generate(envelope)}\n")
      end
    rescue StandardError
      # A raised exception inside a subscriber takes down the developer's request, and the
      # obvious place to complain — Rails.logger — writes into the file we promised not to
      # touch. So a failed write disables emission for the rest of the Run and says nothing.
      @disabled = true
    end

    # Runs once, at the bottom of this file.
    def start
      empty_oversized_sidecar
      open_sidecar

      emit("run_header", {
        kind: run_kind,
        rails_version: Rails.version,
        app_name: Rails.application.class.module_parent_name,
        rails_root: Rails.root.to_s,
        pid: Process.pid
      })

      # Best effort, and worth having: without it a request that was in flight when the
      # process died stays in flight forever, since in-flight requests are given no timeout.
      # puma-dev reaps an idle app with SIGTERM, which Puma traps and exits cleanly, so this
      # runs. SIGKILL does not, and the Reader concludes that Run's end from the next one's
      # header instead. A fork inherits this handler, so a Puma worker ends its own Run.
      at_exit { emit("run_end", {}) }
    rescue StandardError => e
      # The backstop under the named rescues below. Whatever else goes wrong on the way up,
      # the one thing that must not happen is this file being the reason an app fails to boot.
      @disabled = true
      Rails.logger.warn("[rails_log_reader] disabled: #{e.class}: #{e.message}")
    end

    private
      # A Run's identity is memoised with the pid it was derived under and re-derived when
      # that changes. The Initializer loads before a clustered Puma forks, so every worker
      # would otherwise inherit one run_id while keeping its own seq counter — two genuinely
      # different events colliding on (run_id, seq), which is the event identity, so the
      # Reader would silently eat one of them. Spring and Passenger get the same treatment
      # without being named.
      def start_run
        @run_pid = Process.pid
        @run_id = SecureRandom.uuid
        @seq = 0
      end

      def empty_oversized_sidecar
        size = SIDECAR.size?
        return unless size && size > MAX_SIDECAR_BYTES

        File.truncate(SIDECAR, 0)
        Rails.logger.warn(
          "[rails_log_reader] #{SIDECAR} had grown to #{size} bytes, past the 64 MB cap, " \
          "and has been emptied. Anything the Reader had not already read is gone."
        )
      end

      def open_sidecar
        @sidecar = File.open(SIDECAR, File::WRONLY | File::APPEND | File::CREAT, 0o644)
        @sidecar.sync = true
      rescue SystemCallError => e
        # One line, naming the reason, and never a raise: a log reader must never be the
        # thing that stops an app from booting.
        @disabled = true
        Rails.logger.warn(
          "[rails_log_reader] disabled: could not open #{SIDECAR} — #{e.message}"
        )
      end

      def run_kind
        return "console" if defined?(Rails::Console)
        return "rake" if defined?(Rake.application) && Rake.application.top_level_tasks.any?
        return "worker" if defined?(::Sidekiq) && ::Sidekiq.respond_to?(:server?) && ::Sidekiq.server?
        return "server" if booted_by_a_rack_server?

        "unknown"
      end

      # `rails s` leaves a Rails::Server behind, but puma-dev — which is how the app this was
      # written for actually runs — boots straight through config.ru with no such object
      # anywhere. The rack entry point is on the stack either way, and asking for it directly
      # is both narrower and more honest than guessing from a constant some other Run has
      # loaded too.
      def booted_by_a_rack_server?
        caller_locations.any? { |location| location.path.end_with?("config.ru") }
      end

      # A field whose whole weight is under the cap cannot contain a string over it, so the
      # ordinary event is one walk and no allocation. Only an oversized field is walked twice
      # — and only it can be recorded, because a field can be over the cap without any single
      # string in it being over: fifty 2 KB binds are 100 KB that nothing shortens.
      def cut_oversized_fields(payload)
        oversized = {}

        cut = payload.to_h do |field, value|
          size = byte_size(value)
          next [field, value] if size <= MAX_FIELD_BYTES

          shortened = cut_strings(field, value)
          oversized[field] = size if byte_size(shortened) < size
          [field, shortened]
        end

        [cut, oversized.any? ? oversized : nil]
      end

      # Recursive, because a 10 MB string arrives nested inside `params` or `binds` as easily
      # as it arrives as the field itself — and so does the backtrace this must not touch,
      # which a request_finish carries inside its `exception`.
      def cut_strings(name, value)
        return value if KEPT_WHOLE.include?(name.to_s)

        case value
        when String then value.bytesize > MAX_FIELD_BYTES ? cut_string(value) : value
        when Array then value.map { |element| cut_strings(name, element) }
        when Hash then value.to_h { |key, nested| [key, cut_strings(key, nested)] }
        else value
        end
      end

      # `scrub` because the cut can land in the middle of a multibyte character, and a line
      # the Reader cannot parse is a line it skips silently.
      def cut_string(string) = string.byteslice(0, MAX_FIELD_BYTES).scrub("")

      def byte_size(value)
        case value
        when String then value.bytesize
        when Array then value.sum { |element| byte_size(element) }
        when Hash then value.sum { |_, nested| byte_size(nested) }
        else 0
        end
      end
  end
end

RailsLogReader.start
