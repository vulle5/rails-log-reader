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
# This is a copy. The master lives at reader/rails/rails_log_reader.rb in the
# rails-log-reader repo, and that is where to edit it — an edit made here is a difference
# between the two, which is what the repo's CI exists to catch.

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

  # ADR-0003's safety net on top of the per-field cap above. Nothing here ever writes a
  # field over 64 KB except a backtrace, kept whole on purpose — so a single 500 can still
  # run to several hundred KB on one line. A write(2) that large can be split by the kernel,
  # letting a concurrent writer's line land inside ours, which is the one way append order
  # can be corrupted rather than merely surprising. Past this cap the largest field is
  # shrunk further, backtrace included, and the shrink is recorded in `truncated` same as
  # any other.
  MAX_LINE_BYTES = 256 * 1024

  # Request-scoped handoff between the pieces below, which observe the same request on the
  # same thread but never share a method call: the middleware that opens it, and the
  # subscribers that close it. Reset automatically at the request boundary, like every
  # CurrentAttributes — so a bug that leaked a value across requests is not a failure mode
  # this file has to think about.
  class Current < ActiveSupport::CurrentAttributes
    attribute :request_id, :started_at_mono, :status, :view_runtime_ms, :db_runtime_ms, :exception_object
  end

  # Inserted with `insert_after ActionDispatch::RequestId`, so attribution and the request
  # row begin on the *same line of code*: an event observed before its request is
  # structurally impossible, because nothing downstream of here can run before this does.
  # 404s and every other non-controller response still pass through `call`, so they get a
  # request_start (and, eventually, a request_finish) the same as any routed request.
  class Middleware
    def initialize(app) = @app = app

    def call(env)
      RailsLogReader.guard { start_request(env) }

      status, headers, body = @app.call(env)
      RailsLogReader.guard { Current.status = status }

      [status, headers, body]
    end

    private
      def start_request(env)
        request = ActionDispatch::Request.new(env)
        Current.request_id = request.request_id
        Current.started_at_mono = Process.clock_gettime(Process::CLOCK_MONOTONIC, :nanosecond)
        RailsLogReader.emit("request_start", { method: request.request_method, path: request.path },
          request_id: Current.request_id)
      end
  end

  # Object-form on purpose, and `start` does nothing on purpose: `request.action_dispatch`'s
  # own start fires from Rails::Rack::Logger, later than the Middleware's above — the very
  # gap ADR-0002 closed by moving the start marker earlier — so its timestamp is the wrong
  # one to keep. `finish` is deferred to Rack::BodyProxy close, which fires after every
  # middleware has unwound and is the truest "request over" marker available.
  class RequestFinishSubscriber
    def start(_name, _id, _payload); end

    def finish(_name, _id, _payload)
      RailsLogReader.guard do
        RailsLogReader.emit("request_finish", build_payload, request_id: Current.request_id)
      end
    end

    private
      # None of this reads from the notification's own payload — `request.action_dispatch`
      # never carries anything but `request:` — it is all handed off through Current instead.
      def build_payload
        payload = { status: Current.status, duration_ms: duration_ms }
        payload[:view_runtime_ms] = Current.view_runtime_ms if Current.view_runtime_ms
        payload[:db_runtime_ms] = Current.db_runtime_ms if Current.db_runtime_ms
        payload[:exception] = exception_payload if Current.exception_object
        payload
      end

      # The request's own duration, not `process_action.action_controller`'s: it has to
      # cover routing and the middleware either side, not just what ran inside a controller
      # — and it has to exist at all for the 404s that never reach one.
      def duration_ms
        elapsed_ns = Process.clock_gettime(Process::CLOCK_MONOTONIC, :nanosecond) - Current.started_at_mono
        elapsed_ns / 1_000_000.0
      end

      def exception_payload
        exception = Current.exception_object
        { class: exception.class.name, message: exception.message, backtrace: exception.backtrace || [] }
      end
  end

  @mutex = Mutex.new
  @disabled = false
  @run_pid = nil

  class << self
    # Every Event goes through here, inline on the thread that observed it: one mutex, one
    # write, `sync = true`, no queue and no background thread. A drain thread would need a
    # queue bound, a drop policy and a flush at shutdown — and would lose events exactly at
    # shutdown, which is when they matter most.
    #
    # `seq` and both clocks are read under the same lock as the write, so a Run's three
    # orderings — its numbers, its clock and the bytes in the file — can never disagree with
    # each other. What that costs is the lock wait: on a contended write the stamps say when
    # the event reached the file rather than when it was observed, microseconds earlier.
    # Cheap, because the lock is held for one JSON.generate and one append to a page-cached
    # file, and worth it, because an ordering that disagrees with itself reads as a bug in
    # the Reader.
    def emit(type, payload, request_id: nil)
      return if @disabled

      payload, truncated = cut_oversized_fields(payload)

      @mutex.synchronize do
        return if @disabled

        start_run unless @run_pid == Process.pid

        envelope = {
          v: WIRE_VERSION, run_id: @run_id, seq: (@seq += 1),
          at_mono: Process.clock_gettime(Process::CLOCK_MONOTONIC, :nanosecond),
          at_wall: Process.clock_gettime(Process::CLOCK_REALTIME, :millisecond),
          request_id:, type:, payload:
        }
        envelope[:truncated] = truncated if truncated

        @sidecar.write("#{enforce_line_cap(envelope)}\n")
      end
    rescue StandardError
      # A raised exception inside a subscriber takes down the developer's request, and the
      # obvious place to complain — Rails.logger — writes into the file we promised not to
      # touch. So a failed write disables emission for the rest of the Run and says nothing.
      @disabled = true
    end

    # The blanket rescue the Middleware and every subscriber below wrap themselves in: a bug
    # in our own instrumentation code — not the write itself, `emit` already guards that —
    # must never reach `iterate_guarding_exceptions` and take down the developer's request.
    # Silent for the same reason a failed write is silent: the obvious place to complain
    # writes into the file this project promised never to touch.
    def guard
      yield
    rescue StandardError
      nil
    end

    # Runs once, at the bottom of this file.
    def start
      guard_boot do
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
      end
    end

    # Also runs once, at the bottom of this file. A request never gets a row unless this
    # succeeds, so it shares `start`'s own backstop, `guard_boot`, rather than growing a
    # second one.
    def install_request_events
      guard_boot do
        Rails.application.config.middleware.insert_after ActionDispatch::RequestId, Middleware

        ActiveSupport::Notifications.subscribe("request.action_dispatch", RequestFinishSubscriber.new)

        # `params` arrives already run through the app's own `filter_parameters` — Rails does
        # that before this payload exists, not us. Fires only when a controller is entered, so
        # its *absence* is how the Reader tells a routing failure apart from an ordinary 404
        # the app rendered on purpose.
        ActiveSupport::Notifications.subscribe("start_processing.action_controller") do |*, payload|
          guard do
            emit("request_route", {
              controller: payload[:controller], action: payload[:action],
              format: payload[:format]&.to_s, params: payload[:params]
            }, request_id: Current.request_id)
          end
        end

        # The only source for view/db runtime and the exception object with its backtrace —
        # `request.action_dispatch` never carries them. Handed off through Current because
        # this fires, and is gone, well before that finish does.
        ActiveSupport::Notifications.subscribe("process_action.action_controller") do |*, payload|
          guard do
            Current.view_runtime_ms = payload[:view_runtime]
            Current.db_runtime_ms = payload[:db_runtime]
            Current.exception_object = payload[:exception_object]
          end
        end
      end
    end

    private
      # The backstop under `start` and `install_request_events`, both of which run once, at
      # boot. Whatever goes wrong inside, the one thing that must not happen is this file
      # being the reason an app fails to boot — so, unlike `guard`, this one is not silent:
      # it is a boot-time refusal, the kind ADR-0004 says warns exactly once.
      def guard_boot
        yield
      rescue StandardError => e
        @disabled = true
        Rails.logger.warn("[rails_log_reader] disabled: #{e.class}: #{e.message}")
      end
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

          shortened = shrink_to_fit(field, value, MAX_FIELD_BYTES)
          oversized[field] = size if byte_size(shortened) < size
          [field, shortened]
        end

        [cut, oversized.any? ? oversized : nil]
      end

      # Recursive, and the one place this file's three truncation shapes diverge, because
      # they are not the same honesty problem. A String is cut from the end — a shortened
      # string still says what it says. An Array — a backtrace today, a bind list once #20
      # lands — sheds elements from its tail, its least-informative end, which for a
      # backtrace is the framework frames farthest from where it actually broke. A Hash
      # never loses a key: a `params` hash missing one would be a lie about what the request
      # carried, so its values are shrunk instead, evenly, and no key goes unaccounted for.
      #
      # `respect_kept_whole` is true everywhere except the line cap, which is allowed to
      # touch a backtrace that the field cap above must leave alone.
      def shrink_to_fit(field, value, budget, respect_kept_whole: true)
        return value if respect_kept_whole && KEPT_WHOLE.include?(field.to_s)
        return value if byte_size(value) <= budget

        case value
        when String then cut_string(value, budget)
        when Array then shrink_array(field, value, budget, respect_kept_whole:)
        when Hash then shrink_hash(value, budget, respect_kept_whole:)
        else value
        end
      end

      # Keeps whole elements for as long as the budget allows, then — rather than simply
      # dropping the one that finally doesn't fit — spends what is left shrinking it, so a
      # single oversized element does not waste the remainder of the budget on nothing.
      def shrink_array(field, array, budget, respect_kept_whole:)
        kept = []
        remaining = budget

        array.each do |element|
          size = byte_size(element)

          if size <= remaining
            kept << element
            remaining -= size
          else
            kept << shrink_to_fit(field, element, remaining, respect_kept_whole:) if remaining.positive?
            break
          end
        end

        kept
      end

      # An even split rather than a tighter packing: simple, and it never has to decide
      # whose value mattered more. `key` becomes the next call's `field`, so a nested
      # `backtrace` — the shape it actually arrives in, inside a request_finish's
      # `exception` — is still recognised by `KEPT_WHOLE` wherever it turns up.
      def shrink_hash(hash, budget, respect_kept_whole:)
        return hash if hash.empty?

        per_key = budget / hash.size
        hash.to_h { |key, value| [key, shrink_to_fit(key, value, per_key, respect_kept_whole:)] }
      end

      # `scrub` because the cut can land in the middle of a multibyte character, and a line
      # the Reader cannot parse is a line it skips silently.
      def cut_string(string, budget) = string.byteslice(0, [budget, 0].max).scrub("")

      def byte_size(value)
        case value
        when String then value.bytesize
        when Array then value.sum { |element| byte_size(element) }
        when Hash then value.sum { |_, nested| byte_size(nested) }
        else 0
        end
      end

      # ADR-0003's whole-line safety net, on top of the per-field cap `cut_oversized_fields`
      # already applied. The only field that can still be this large is a backtrace, kept
      # whole by `KEPT_WHOLE` on purpose — so unlike that cap, this one is allowed to shrink
      # it: a `write(2)` too large to be atomic is the one way append order can be corrupted,
      # and that risk outranks keeping a backtrace whole. Bounded at three passes so a
      # pathological line cannot loop forever; one is the overwhelming common case; three
      # comfortably covers JSON's own escaping overhead eating into an estimate.
      def enforce_line_cap(envelope)
        line = JSON.generate(envelope)

        3.times do
          break if line.bytesize <= MAX_LINE_BYTES

          shrink_largest_field(envelope, line.bytesize)
          line = JSON.generate(envelope)
        end

        line
      end

      def shrink_largest_field(envelope, line_bytesize)
        payload = envelope[:payload]
        return if payload.empty?

        field, value = payload.max_by { |_, v| byte_size(v) }
        original = envelope.dig(:truncated, field) || byte_size(value)
        budget = [byte_size(value) - (line_bytesize - MAX_LINE_BYTES) - 1024, 0].max

        payload[field] = shrink_to_fit(field, value, budget, respect_kept_whole: false)
        (envelope[:truncated] ||= {})[field] = original
      end
  end
end

RailsLogReader.start
RailsLogReader.install_request_events
