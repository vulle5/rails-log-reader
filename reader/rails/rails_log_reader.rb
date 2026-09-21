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
# exactly what it shows today.
#
# Events are appended, one JSON object per line, to log/rails_log_reader.jsonl, which Rails'
# own .gitignore already covers. The Reader tails that file and never writes to it. Nothing
# is ever written into log/development.log except the boot warnings below, which sit below
# the same gate.
#
# This is a copy. The master lives at reader/rails/rails_log_reader.rb — edit there.

# The one gate: with no marker file, or in any environment but development, the rest of this
# file never happens. `development?` is an allowlist — production, staging and test are all
# refused. The marker file's *presence* is the whole switch; its contents are never read.
# Both questions are answered once, at boot, so a marker file change needs a restart to take
# effect.
return unless Rails.env.development? && Rails.root.join("log/rails_log_reader.enabled").exist?

# ActiveSupport::BroadcastLogger#broadcast_to is the only way to read Rails.logger without
# changing what log/development.log contains, and Rails 7.0 does not have it. Its 7.0
# substitute is deprecated, undocumented and cannot be detached again.
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
  # Stamped on every envelope, and bumped when a field changes meaning for the reading half —
  # including when a field a Reader could once count on becomes one it has to check for. The
  # Reader reads it to tell "the new file is loaded" from "the file on disk is new but the
  # process is not".
  WIRE_VERSION = 3

  SIDECAR = Rails.root.join("log/rails_log_reader.jsonl")

  # The disk bound, checked once at boot and never again.
  MAX_SIDECAR_BYTES = 64 * 1024 * 1024

  # A field past this is cut, and its original byte length is recorded under `truncated` so
  # the Reader can say "showing 64KB of 812KB". A backtrace is exempt and kept whole: "the
  # bug was in a gem" has to stay an answer the Reader can give.
  MAX_FIELD_BYTES = 64 * 1024
  KEPT_WHOLE = %w[backtrace].freeze

  # A safety net on top of the per-field cap above. Nothing here ever writes a field over
  # 64 KB except a backtrace, kept whole on purpose — so a single 500 can still run to
  # several hundred KB on one line. A write(2) that large can be split by the kernel, letting
  # a concurrent writer's line land inside ours, which is the one way append order can be
  # corrupted. Past this cap the largest field is shrunk further, backtrace included, and the
  # shrink is recorded in `truncated` same as any other.
  MAX_LINE_BYTES = 256 * 1024

  # Request-scoped handoff between the pieces below, which observe the same request on the
  # same thread but never share a method call: the middleware that opens it, and the
  # subscribers that close it.
  #
  # Backed by `ActiveSupport::IsolatedExecutionState`, the same per-execution-context storage
  # `rails_log_reader_sql_starts` below already uses — which Rails does not clear at a request
  # boundary on its own. This file clears its own key by hand, at `executor.to_complete`
  # (registered in `install_request_events`), the same boundary Rails uses to clear
  # `CurrentAttributes`. A value leaking across requests would attribute the next request's
  # events, and every unattributed line in between, to a request that is already over.
  module Current
    KEY = :rails_log_reader_request
    ATTRIBUTES = %i[request_id started_at_mono status controller_status view_runtime_ms db_runtime_ms
                    exception_object].freeze

    class << self
      # A pair of accessors per attribute, over one Hash. Reading never creates it, so the
      # ordinary unattributed event — a boot line, a rake task's query — costs one lookup and
      # no allocation, and `nil` is the answer to every question asked outside a request.
      ATTRIBUTES.each do |attribute|
        define_method(attribute) { ActiveSupport::IsolatedExecutionState[KEY]&.fetch(attribute, nil) }

        define_method(:"#{attribute}=") do |value|
          (ActiveSupport::IsolatedExecutionState[KEY] ||= {})[attribute] = value
        end
      end

      def reset = ActiveSupport::IsolatedExecutionState.delete(KEY)
    end
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
  # own start fires from Rails::Rack::Logger, later than the Middleware's above, so its
  # timestamp is the wrong one to keep. `finish` is deferred to Rack::BodyProxy close, which
  # fires after every middleware has unwound and is the truest "request over" marker
  # available.
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
      #
      # A `status` of `nil` stays on the wire as `null`: a request whose `@app.call` never
      # returned has no response to read a status off, and a status this file did not observe
      # would be one it made up.
      #
      # `Current.controller_status`, when there is one, wins over `Current.status` — the
      # Rack-final status `Middleware` reads off `@app.call`'s own return. The two can
      # disagree: `Rack::ConditionalGet` and `Rack::ETag` sit below `Middleware` in the
      # default stack and can swap a controller's 200 for an empty 304 on a matching
      # `If-None-Match`, after `ActionController::LogSubscriber` has already logged
      # `Completed 200 OK` from the same payload `controller_status` is read from.
      # `Middleware`'s status is the fallback: a request that never reached a controller never
      # gets a `controller_status` at all, and its Rack-final status is the only one there is.
      def build_payload
        duration = duration_ms
        payload = { status: Current.controller_status || Current.status }
        payload[:duration_ms] = duration if duration
        payload[:view_runtime_ms] = Current.view_runtime_ms if Current.view_runtime_ms
        payload[:db_runtime_ms] = Current.db_runtime_ms if Current.db_runtime_ms

        exception = Current.exception_object || escaping_exception
        payload[:exception] = exception_payload(exception) if exception
        payload
      end

      # The exception that took the response away, when nothing handed one over. Only a
      # request that reached a controller gets `process_action.action_controller`'s — and the
      # ones that raise above `ShowExceptions` never do: a spoofed `Client-IP` raises from
      # inside `Rails::Rack::Logger`'s own `Started GET` line, on default settings. There is
      # no handing this one through Current either, because Logger emits this finish from its
      # own `rescue Exception` and only then re-raises, so the raise reaches the Middleware
      # after the finish has already been written. Inside that rescue, `$!` is the exception,
      # and it is the only place it exists yet.
      #
      # Asked only when there is no status. `$!` is whatever this thread is handling, and a
      # finish from a response's `BodyProxy` close can run inside a rescue that has nothing
      # to do with the request — which returned, and so has a status to prove it.
      def escaping_exception
        $! if Current.status.nil?
      end

      # The request's own duration, not `process_action.action_controller`'s: it has to
      # cover routing and the middleware either side, not just what ran inside a controller —
      # and it has to exist at all for the 404s that never reach one.
      #
      # A finish is a fact about a request that ended, and the one field it cannot measure
      # must not be able to take the whole event down with it. No start to measure from is
      # `nil` here and a field left off the wire there — absence, the same answer `row_count`
      # gets above, and never a zero that would read as an instant request. A missing start is
      # also what a `run_end` mid-request leaves behind.
      def duration_ms
        return unless Current.started_at_mono

        elapsed_ns = Process.clock_gettime(Process::CLOCK_MONOTONIC, :nanosecond) - Current.started_at_mono
        elapsed_ns / 1_000_000.0
      end

      def exception_payload(exception)
        { class: exception.class.name, message: exception.message, backtrace: exception.backtrace || [] }
      end
  end

  # Object-form for one reason, and it is not the duration: `publish_event`. A `load_async`
  # query is instrumented on a background thread and *replayed* on the request thread by
  # ActiveRecord::FutureResult::EventBuffer#flush, which publishes the finished Event rather
  # than calling start and finish. Fanout hands that to a subscriber's own `publish_event`
  # if it has one and otherwise to `publish`, which this file does not define — so a
  # subscriber without the method below loses every async query and says nothing. That
  # cannot show up in the Example app, which configures no async query executor for
  # `load_async` to use; it bites only in the tuned Work app this exists for.
  #
  # Every query is forwarded, including the SCHEMA and EXPLAIN ones ActiveRecord's own log
  # subscriber drops: "why was the first request after a restart the slow one" is a question
  # only the dropped ones answer.
  class SqlSubscriber
    # Neither call of the object form carries a duration, so the start's clock reading waits
    # here for its finish. A stack, and per execution context, for the reason
    # ActiveSupport::Subscriber keeps its own event stack the same way: only the thread that
    # observed the start can close it.
    def start(_name, _id, _payload)
      RailsLogReader.guard { starts.push(now_ns) }
    end

    def finish(_name, _id, payload)
      started_at = starts.pop
      # Nothing to pop is a query that was already in flight on this thread when this
      # subscriber was registered at boot. There is no duration to give it, and inventing
      # one would be a worse answer than the one boot-time query this costs.
      return unless started_at

      RailsLogReader.guard { record(payload, (now_ns - started_at) / 1_000_000.0, callsite:) }
    end

    # `event.time` is float milliseconds off the same CLOCK_MONOTONIC everything else here
    # reads, taken on the background thread when the query really went to the database — so
    # it, and not this moment, is what `at_mono` carries, while `seq` records the replay.
    # `event.duration` is Rails' own measurement of a query this thread never saw run. No
    # callsite: this stack is the flush's, and says nothing about the code that issued it.
    def publish_event(event)
      RailsLogReader.guard do
        record(event.payload, event.duration, at_mono: (event.time * 1_000_000).round)
      end
    end

    private
      def starts = ActiveSupport::IsolatedExecutionState[:rails_log_reader_sql_starts] ||= []

      def now_ns = Process.clock_gettime(Process::CLOCK_MONOTONIC, :nanosecond)

      def record(payload, duration_ms, at_mono: nil, callsite: nil)
        query = { sql: payload[:sql], name: payload[:name], duration_ms:,
                  cached: payload[:cached] || false, async: payload[:async] || false }
        # Rails 7.1 and 7.2 carry no `:row_count` at all — nor the `:transaction` this file
        # has no use for — and absence is absence: the field is left off the wire rather
        # than sent as a zero that would read as a query returning nothing.
        query[:row_count] = payload[:row_count] if payload.key?(:row_count)
        query[:binds] = binds(payload)
        query[:callsite] = callsite if callsite

        RailsLogReader.emit("sql", query, request_id: Current.request_id, at_mono:)
      end

      # The first frame the Host app's own backtrace cleaner keeps — the loop
      # ActiveRecord::LogSubscriber runs for the `↳` line `verbose_query_logs` prints, so this
      # is that line's text byte for byte, a team's own cleaner customisations included, and
      # captured whether the setting is on or not. Usually relative to the app root, and nil
      # for a query issued from anywhere the cleaner silences, which has no `↳` line either.
      #
      # This file's frames are skipped by hand: it sits under config/initializers/, which the
      # cleaner keeps as app code, so it would otherwise be the first clean frame of every
      # query there is. `first_clean_frame` would do the walk itself, but only from Rails 8.0.
      def callsite
        return unless Thread.respond_to?(:each_caller_location)

        cleaner = ActiveRecord::LogSubscriber.backtrace_cleaner
        Thread.each_caller_location do |location|
          next if location.absolute_path == __FILE__

          frame = cleaner.clean_frame(location)
          return frame if frame
        end
        nil
      end

      # Filtered here, by us, with the filter `ActiveRecord::Base#inspect` uses, because
      # development.log redacts bind values and a file that did not would be a downgrade the
      # developer never asked for. An empty list is the ordinary case, not a degraded one:
      # mysql2 and trilogy never parameterize at the wire level, and any app with QueryLogs
      # enabled has prepared statements switched off, which puts every value in the SQL
      # string instead.
      def binds(payload)
        binds = payload[:binds]
        return [] if binds.nil? || binds.empty?

        casted = casted_binds(payload, binds)
        filter = ActiveRecord::Base.inspection_filter

        binds.each_with_index.map do |bind, index|
          serialize(filter.filter_param(name_of(bind), casted[index]))
        end
      end

      # `type_casted_binds` is the value as the adapter would send it, and it arrives as a
      # lazy Proc when the query cache re-instruments a hit — hence "whenever it is
      # callable", which is what ActiveRecord::LogSubscriber does and the reason a CACHE line
      # in development.log has values at all. An adapter that carries fewer of them than
      # there are binds — none at all, or an empty array beside a full one — falls back to
      # the binds' own values, because indexing past the end of that list would put a row of
      # `null`s on the wire and `null` is a legal bind value the Reader would render.
      def casted_binds(payload, binds)
        casted = payload[:type_casted_binds]
        casted = casted.call if casted.respond_to?(:call)
        return casted if casted && casted.size >= binds.size

        binds.map { |bind| bind.respond_to?(:value) ? bind.value : bind }
      end

      # Only ever to give the filter something to match on — the name itself never reaches
      # the wire. An ActiveModel::Attribute knows its own; some adapters hand binds over as
      # [attribute, value] pairs instead.
      def name_of(bind)
        return bind.name if bind.respond_to?(:name)

        bind.first.name if bind.is_a?(Array) && bind.first.respond_to?(:name)
      end

      # A value that is already a JSON primitive goes as-is; anything else goes as its
      # `to_s`. The filter has already run by the time a value gets here, and `[FILTERED]` is
      # a delegator around a String rather than a String, so it takes the `to_s` branch and
      # stays filtered. How any of this is *displayed* is the Reader's problem, not this
      # file's.
      #
      # A bind that is BINARY-encoded or not `valid_encoding?` goes through unscrubbed here:
      # whatever this returns still has to survive `cut_oversized_fields` before it reaches
      # the wire, same as every other field on the envelope.
      def serialize(value)
        case value
        when nil, true, false, Integer then value
        when Float then value.finite? ? value : value.to_s
        when Time, DateTime then value.iso8601(3)
        when String then value
        else value.to_s
        end
      end
  end

  # The sink on Rails.logger, and the one piece of this file that could rewrite what a
  # colleague reads. `broadcast_to` appends it, so development.log's own logger stays first
  # in the broadcast and keeps answering for it: `dispatch` returns the first sink's value,
  # and `Rails.logger.formatter` hands back the first sink's formatter.
  #
  # A plain ::Logger, never an ActiveSupport::TaggedLogging one. A call a BroadcastLogger
  # does not dispatch itself goes through `method_missing`, which forwards to *every* sink
  # that responds and — unlike `dispatch` — does not memoise the block. With two tagged sinks
  # in the broadcast, `Rails.logger.tagged("X") { ... }` would run its block twice and
  # development.log would gain the line twice, once tagged and once not, because the first
  # sink has already popped by the time the second runs it; `push_tags` comes back as
  # [["X"], ["X"]], so `tagged` then pops two tags for one push. This sink responds to none
  # of that, so a tag can only ever be read.
  #
  # One capture gap comes with that, and it is Rails' own rather than ours:
  # `Rails.logger.tagged("X")` *without* a block returns a tagged clone of whichever single
  # sink answered — development.log's — and lines written through that object never reach the
  # broadcast, so they never reach here.
  class LoggerSink < ::Logger
    SEVERITIES = %w[debug info warn error fatal unknown].freeze

    # Stripped, never interpreted: development.log carries ANSI because a terminal reads it,
    # and the Reader is not a terminal. Every colourised Rails line has these — the SQL
    # `verbose_query_logs` writes most of all.
    ANSI = /\e\[[0-9;]*[a-zA-Z]/

    # Deep enough to clear the five frames a broadcast dispatch costs, and bounded because
    # this runs on every log line and a full backtrace is not free.
    FRAME_DEPTH = 12

    # Level UNKNOWN, and yet nothing here is filtered by level — the two are one decision.
    # `BroadcastLogger#level` is the *minimum* across its sinks and every `debug?` is an
    # `any?`, so a sink claiming the highest severity there is cannot change a single answer
    # the broadcast gives about itself, while an `add` that reads no level drops nothing that
    # reaches it. What `log_level` hides is development.log's business; the Console's own
    # per-level chips are the Reader's, and they need the lines to be there to hide them.
    #
    # The same reasoning is why this is not an ActiveSupport::Logger: that one answers
    # `local_level=`, which is how `silence` works, so `config.assets.quiet` and every
    # `logger.silence` block would reach in here and take lines out. A sink that cannot be
    # silenced keeps them, exactly as SqlSubscriber keeps the SCHEMA queries Rails' own log
    # subscriber drops.
    def initialize
      super(nil, level: UNKNOWN)

      # Both of these are asked of Ruby rather than spelled out, so a gem update that moves a
      # file cannot quietly relabel every line in the Console — and both are asked *here*
      # rather than in a constant, which would be evaluated as this file is read and so
      # outside `guard_boot`'s reach. Where a method lives is exactly the kind of question a
      # Rails version this has never met could answer with a NameError, and a log reader must
      # never be the thing that stops an app from booting. Built inside
      # `install_app_log_events`, that costs the Console and one warning instead.
      #
      # The machinery is the files that stand between a `Rails.logger.info` and the `add`
      # below: the broadcast that dispatched it, ::Logger's own severity methods, and this
      # file. The gem roots are where the installed gems sit, taken from the specs Bundler
      # activated — one directory in the ordinary case, a second when the bundle holds a
      # git-sourced gem, and whatever `vendor/bundle` adds when an app keeps its gems inside
      # its own root.
      @machinery_paths = [
        __FILE__,
        ::Logger.instance_method(:add).source_location&.first,
        ActiveSupport::BroadcastLogger.instance_method(:info).source_location&.first
      ].compact.freeze

      @gem_roots = Gem.loaded_specs.values.map { |spec| File.dirname(spec.full_gem_path) }.uniq.freeze
    end

    # Where every logging call on the broadcast arrives: `info`, `debug` and the rest all
    # funnel into `add`. `log` is ::Logger's own alias for it, and an alias keeps the method
    # it was given — so without the one below, `Rails.logger.log(...)` would still reach the
    # original, which writes to a log device this sink does not have and loses the line
    # without a word.
    def add(severity, message = nil, progname = nil)
      severity ||= UNKNOWN
      frames = caller_locations(1, FRAME_DEPTH)

      RailsLogReader.guard do
        # The block form is the one place this sink could change what the app itself does.
        # BroadcastLogger#dispatch memoises the block so that it runs once for the whole
        # broadcast — but only once *something* runs it, and a sink whose level suppresses
        # the line never does. Being last in the broadcast, ours would then be the first and
        # only caller: a `logger.debug { expensive }` that a Work app's log_level had made
        # free would start costing it again, and a block that raises would raise out of this
        # method and into the developer's request. So the block is read only once the rest of
        # the broadcast has already read it, which `Rails.logger.level` answers exactly, this
        # sink's own UNKNOWN being unable to lower that minimum. There is no message to
        # record without it, so there is no event.
        #
        # A message that arrived already built is a different question and gets the opposite
        # answer, above: keeping a string the app has already paid for costs it nothing.
        if message.nil? && block_given?
          next unless Rails.logger.level <= severity

          message = yield
        end

        record(severity, message.nil? ? progname : message, frames)
      end

      true
    end
    alias_method :log, :add

    # ::Logger writes `<<` straight to its log device, bypassing `add` and every severity
    # there is. Whatever the caller meant by it, they did not say.
    def <<(message) = add(UNKNOWN, message)

    private
      def record(severity, message, frames)
        source, frame = source_of(frames)
        line = {
          severity: SEVERITIES.fetch(severity, "unknown"),
          message: message.to_s.gsub(ANSI, ""),
          source:,
          tags: current_tags
        }
        line[:callsite] = frame.to_s if frame

        RailsLogReader.emit("app_log", line, request_id: Current.request_id)
      end

      # Deterministic, and never a guess at the message's shape: the first frame that is not
      # the logging machinery is whoever wrote the line, and a frame inside a gem is not the
      # developer. That is the split the Console needs — mine and not-mine — so Rails' own
      # lines and a third-party gem's are both `rails`, and a line from `app/`, from
      # `lib/tasks`, from an initializer or typed into `rails c` is `app` wherever its file
      # happens to sit. An app carrying an engine as a `path:` gem is the coarse case: those
      # frames sit under a gem root too, and read as `rails`.
      #
      # The frame comes back beside the verdict and becomes the line's callsite, so where a
      # line is said to come from and who is said to have written it are one answer. It stops
      # at the first frame outside the machinery even when that is a gem's own, because that
      # gem is who wrote the line. Nil when nothing lies outside the machinery.
      def source_of(frames)
        frame = frames&.find { |location| !@machinery_paths.include?(location.path) }
        return [ "rails", nil ] unless frame&.path

        [ frame.path.start_with?(*@gem_roots) ? "rails" : "app", frame ]
      end

      # Read, and only ever read. `Rails.logger.formatter` is dispatched to every sink and
      # answers with the first one's, which is development.log's own tagged formatter — so
      # these are exactly the tags that file is being written with, a team's custom
      # `log_tags` included, and the push/pop accounting behind them is never touched.
      # `respond_to?` because an app that replaced its formatter has no tags, which is not an
      # error.
      def current_tags
        formatter = Rails.logger.formatter
        return [] unless formatter.respond_to?(:current_tags)

        formatter.current_tags.map(&:to_s)
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
    #
    # `at_mono` is that stamp for everything but one case: a `load_async` query, issued on a
    # background thread and replayed on the request thread long after. There `seq` records
    # the replay and `at_mono` has to record the issue — so a caller that knows the true
    # moment hands it in rather than letting this method invent a later one.
    def emit(type, payload, request_id: nil, at_mono: nil)
      return if @disabled

      payload, truncated = cut_oversized_fields(payload)

      @mutex.synchronize do
        return if @disabled

        start_run unless @run_pid == Process.pid

        envelope = {
          v: WIRE_VERSION, run_id: @run_id, seq: (@seq += 1),
          at_mono: at_mono || Process.clock_gettime(Process::CLOCK_MONOTONIC, :nanosecond),
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

        # `Current`'s reset: what the CurrentAttributes it replaced got for free, put back by
        # hand at the same boundary Rails used for it. `ActionDispatch::Executor` sits well
        # above the Middleware below, and completes the request either from the response
        # body's close or — on Rack 3.1 and up, which is every server this runs under —
        # from `rack.response_finished`. Same ordering either way: this runs after every
        # middleware inside it has unwound and after the `request_finish` that closes the
        # row. Its `ensure` covers the paths where `@app.call` raises rather than returns,
        # which is the case with no `BodyProxy` to hang a close on at all.
        #
        # The reset is registered here rather than in the Middleware because the finish
        # arrives *after* `call` has returned, so an `ensure` there would clear the context
        # out from under it.
        #
        # Registration order is the boundary, and this file is late on purpose. Rails
        # registers its own `CurrentAttributes.clear_all` from a railtie initializer, which
        # runs before `config/initializers/` — and `to_complete` callbacks are `:before`
        # kind, so they run in registration order. This one therefore runs *after* Rails'
        # own, leaving the *Trailing event* window as wide as it was, never narrower. Blocks
        # registered on the executor are instance_exec'd against it, hence the explicit
        # receiver on `guard`.
        Rails.application.executor.to_complete { RailsLogReader.guard { Current.reset } }

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

        # The only source for view/db runtime, the exception object with its backtrace, and
        # the status the controller actually produced — `request.action_dispatch` never
        # carries any of them. Handed off through Current because this fires, and is gone,
        # well before that finish does.
        #
        # `payload[:status]` is `response.status` on the ordinary path, but not only there:
        # `ActionController::Instrumentation#process_action` rescues whatever the action
        # raises, maps it to a status with the same `ActionDispatch::ExceptionWrapper.
        # status_code_for_exception` `ActionController::LogSubscriber` reads to print
        # `Completed`, stamps the payload with it, and only then re-raises — so a raise inside
        # a reached controller does not leave this `nil`, and `Current.controller_status` ends
        # up set to whatever development.log's own `Completed` line would say, matching it
        # even though the exception goes on past this notification. `build_payload` falls
        # back to `Middleware`'s Rack-final status only for the request this notification
        # never fired for at all — a routing failure or a raise above `ShowExceptions`, where
        # no controller was ever reached to rescue anything.
        ActiveSupport::Notifications.subscribe("process_action.action_controller") do |*, payload|
          guard do
            Current.controller_status = payload[:status]
            Current.view_runtime_ms = payload[:view_runtime]
            Current.db_runtime_ms = payload[:db_runtime]
            Current.exception_object = payload[:exception_object]
          end
        end
      end
    end

    # The third of the four things the bottom of this file runs, sharing `start`'s backstop
    # for the same reason the others do.
    def install_sql_events
      guard_boot do
        ActiveSupport::Notifications.subscribe("sql.active_record", SqlSubscriber.new)
      end
    end

    # The fourth and last, and the one that has to come after `start`: the sink starts
    # capturing the moment it is attached, so it is attached only once there is somewhere to
    # write to.
    def install_app_log_events
      guard_boot do
        # Rails wraps whatever `config.logger` is in a BroadcastLogger at boot, so this is
        # only ever false when something replaced Rails.logger afterwards — a gem's railtie
        # initializer runs before this file does. The branch is here rather than left to
        # `guard_boot` because of what the two cost: an unguarded `broadcast_to` would raise,
        # and `guard_boot` would disable this file for the whole Run, taking requests and
        # queries down with the Console. Nothing else here depends on a sink, so this refuses
        # the Console alone and says which one it refused.
        if Rails.logger.respond_to?(:broadcast_to)
          Rails.logger.broadcast_to(LoggerSink.new)
        else
          Rails.logger.warn(
            "[rails_log_reader] no app_log events: Rails.logger is a #{Rails.logger.class}, " \
            "which cannot be broadcast to. Requests and queries are unaffected."
          )
        end
      end
    end

    private
      # The backstop under the four methods above, all of which run once, at boot. Whatever
      # goes wrong inside, the one thing that must not happen is this file being the reason
      # an app fails to boot — so, unlike `guard`, this one is not silent: it is a boot-time
      # refusal that warns exactly once.
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

      # `rails s` leaves a Rails::Server behind, but puma-dev boots straight through
      # config.ru with no such object anywhere. The rack entry point is on the stack either
      # way, so this asks for it directly rather than guessing from a constant some other Run
      # has loaded too.
      def booted_by_a_rack_server?
        caller_locations.any? { |location| location.path.end_with?("config.ru") }
      end

      # A field whose whole weight is under the cap cannot contain a string over it, so the
      # ordinary event is one walk and no allocation. Only an oversized field is walked twice
      # — and only it can be recorded, because a field can be over the cap without any single
      # string in it being over: fifty 2 KB binds are 100 KB that nothing shortens.
      #
      # That one walk also carries the scrub: `scrub_and_size` is `byte_size` with a second
      # job, checking every String it visits for the encoding `JSON.generate` cannot carry,
      # wherever it sits nested inside an Array or a Hash.
      def cut_oversized_fields(payload)
        oversized = {}

        cut = payload.to_h do |field, value|
          value, size = scrub_and_size(value)
          next [field, value] if size <= MAX_FIELD_BYTES

          shortened = shrink_to_fit(field, value, MAX_FIELD_BYTES)
          oversized[field] = size if byte_size(shortened) < size
          [field, shortened]
        end

        [cut, oversized.any? ? oversized : nil]
      end

      # `byte_size` below, plus one check `String` alone needs: BINARY-encoded or not
      # `valid_encoding?` is not "large", it is "may not reach JSON.generate at all", so it is
      # caught here rather than left for `shrink_to_fit` to discover as an oversized field
      # that never shrinks. Returns the value alongside its size, same as the field it sits
      # in eventually needs both — and returns the very same object when there is nothing to
      # scrub, so an ordinary event's Arrays and Hashes are never rebuilt, only walked. A
      # String, Array or Hash that turns out to need scrubbing is rebuilt one level at a
      # time going back up, the same "only pay when there's something to fix" shape
      # `shrink_to_fit` already uses for size below.
      #
      # Not recorded in `truncated`: that field is specifically the original byte length
      # before a shrink, and a scrub is not a length change in the cases that matter most — a
      # bind's `<N bytes of binary data>` already says what happened in its own text, the
      # same as `truncated` would, and a handful of bad bytes dropped from otherwise-readable
      # text is the same silent, in-place correction `cut_string` already makes below when a
      # byte-slice lands mid-character. A second field recording the same kind of fix that
      # field already leaves unrecorded would be new machinery for old behaviour.
      def scrub_and_size(value)
        case value
        when String
          return [value, value.bytesize] if value.encoding != Encoding::BINARY && value.valid_encoding?

          scrubbed = scrub_utf8(value)
          [scrubbed, scrubbed.bytesize]
        when Array
          scrub_elements(value) { |element| scrub_and_size(element) }
        when Hash
          scrub_values(value) { |nested| scrub_and_size(nested) }
        else
          [value, 0]
        end
      end

      # `equal?`, not `==`, is what makes the "rebuild only what changed" promise above hold:
      # a String that scrubbed to something that reads the same (`scrub` on an already-valid
      # copy, say) is still a different object, and comparing identity rather than value is
      # the only way to know that *this* element never needed the walk at all.
      def scrub_elements(array)
        scrubbed = nil
        size = 0

        array.each_with_index do |element, index|
          safe, element_size = yield(element)
          size += element_size
          next if safe.equal?(element)

          (scrubbed ||= array.dup)[index] = safe
        end

        [scrubbed || array, size]
      end

      # `Array`'s own mirror above; a `key` is never touched, only ever the `value` beside
      # it — a key holding a bad byte would be an app doing something stranger than this file
      # has any business correcting for it.
      def scrub_values(hash)
        scrubbed = nil
        size = 0

        hash.each do |key, nested|
          safe, nested_size = yield(nested)
          size += nested_size
          next if safe.equal?(nested)

          (scrubbed ||= hash.dup)[key] = safe
        end

        [scrubbed || hash, size]
      end

      # Two different strings, two different honest answers — not one rule wearing an
      # exception. A string merely tagged UTF-8 that picked up a handful of bad bytes — a
      # gem's exception message, a query string ActionDispatch never validated — is not
      # opaque, and throwing the whole thing away would lose a log line that was otherwise
      # perfectly legible. `scrub("")` is `cut_string`'s own answer to that problem already,
      # a few lines down.
      #
      # BINARY is not by itself that other case: it is Ruby's "nobody said what this is"
      # tag, and Puma hands out request_method under it even though every method is plain
      # ASCII (`rb_str_new` with no encoding, right beside header values the same C
      # extension does tag UTF-8) — a mislabel, not a blob. Re-reading the bytes as UTF-8 is
      # how to tell that from an actual blob apart: valid, and it was text all along, so it
      # is re-tagged and passed straight through — `JSON.generate` reads a string's current
      # encoding, not what it used to be tagged, and re-tagging here rather than trusting
      # `JSON.generate`'s own BINARY-tolerant fallback keeps this working once the json gem
      # drops that fallback. Invalid, and there is no readable part to salvage, so it goes as
      # its size, the same answer development.log gives for a bind and now every other field
      # too.
      def scrub_utf8(string)
        if string.encoding == Encoding::BINARY
          retagged = string.dup.force_encoding(Encoding::UTF_8)
          return retagged if retagged.valid_encoding?

          return "<#{string.bytesize} bytes of binary data>"
        end

        string.scrub("")
      end

      # Recursive, and the one place this file's three truncation shapes diverge, because
      # they are not the same honesty problem. A String is cut from the end — a shortened
      # string still says what it says. An Array — a backtrace, or a bind list — sheds
      # elements from its tail, its least-informative end, which for a backtrace is the
      # framework frames farthest from where it actually broke. A Hash
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

      # A whole-line safety net, on top of the per-field cap `cut_oversized_fields` already
      # applied. The only field that can still be this large is a backtrace, kept whole by
      # `KEPT_WHOLE` on purpose — so unlike that cap, this one is allowed to shrink it: a
      # `write(2)` too large to be atomic is the one way append order can be corrupted.
      # Bounded at three passes so a pathological line cannot loop forever; one is the
      # overwhelming common case; three comfortably covers JSON's own escaping overhead
      # eating into an estimate.
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
RailsLogReader.install_sql_events
RailsLogReader.install_app_log_events
