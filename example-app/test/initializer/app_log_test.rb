require "test_helper"
require "support/development_run"

# The BroadcastLogger sink: every Rails.logger call reaching the Sidecar as an app_log —
# the developer's own lines and Rails' own, labelled apart rather than one of them dropped —
# without changing a byte of what development.log contains. That last half is not asserted
# here: development_log_test.rb is where it lives, and this is the change that finally gives
# it something to catch.
class AppLogTest < ActiveSupport::TestCase
  # App code that logs inside a request, which the Example app deliberately has none of —
  # #30 owns the traffic shapes, and a log line added to a controller for a test's sake would
  # be one of them arriving early. `config/` is copied into every Run's root, so an
  # initializer dropped in there is app code by each measure that matters here: it is the
  # developer's file, it is not in a gem, and its `before_action` runs on the request thread.
  LOGS_IN_REQUEST = <<~RUBY
    ActiveSupport.on_load(:action_controller) do
      before_action { Rails.logger.info("a line from inside the request") }
    end
  RUBY

  test "a Rails.logger call inside a request is attributed to it, in its own timeline, and labelled app" do
    run = boot_logging_request("/posts")

    assert run.booted?, run.output
    start = run.events_of("request_start").sole
    finish = run.events_of("request_finish").sole
    line = app_log(run, "a line from inside the request")

    assert line, "the controller's own log line never reached the Sidecar"
    assert_equal start["request_id"], line["request_id"],
      "the sink reads Current on the request thread, so it knows whose line this is"
    assert_operator start["seq"], :<, line["seq"]
    assert_operator line["seq"], :<, finish["seq"]

    assert_equal "info", line["payload"]["severity"]
    assert_equal "app", line["payload"]["source"]
    assert_equal [], line["payload"]["tags"]
  end

  # The frame that decided `app` or `rails` is the frame the Reader will open, so the two can
  # never disagree about who wrote a line.
  test "a line's callsite is the very frame its source was decided by" do
    run = boot_logging_request("/posts")

    assert run.booted?, run.output
    mine = app_log(run, "a line from inside the request")
    assert mine, "the controller's own log line never reached the Sidecar"
    assert_match %r{/config/initializers/z_logs_in_request\.rb:2:in }, mine["payload"]["callsite"]

    started = app_log(run) { |message| message.start_with?(%(Started GET "/posts")) }
    assert_equal "rails", started["payload"]["source"]
    assert_match %r{/rails/rack/logger\.rb:\d+:in }, started["payload"]["callsite"],
      "Rails wrote it, and the frame that says so is Rails' own"
  end

  # The Console would be strictly worse than the file it improves on if it dropped these: a
  # request that dies before reaching a controller emits no request_route, and `Started GET`
  # is then the only thing that says what was asked for.
  test "Rails' own lines are kept, labelled rails, and attributed to the request that caused them" do
    run = DevelopmentRun.boot(script: DevelopmentRun.real_request("/no/such/route"))

    assert run.booted?, run.output
    assert_empty run.events_of("request_route"), "nothing routed, which is the case being covered"
    request_id = run.events_of("request_start").sole["request_id"]

    started = app_log(run) { |message| message.start_with?(%(Started GET "/no/such/route")) }
    assert started, "the one line naming what was asked for never reached the Sidecar"
    assert_equal "rails", started["payload"]["source"],
      "Rails::Rack::Logger wrote it, and no pattern in the message was consulted to say so"
    assert_equal "info", started["payload"]["severity"]
    assert_equal request_id, started["request_id"],
      "it is logged inside our own middleware's span, so it belongs to the request it names"
  end

  # Boot is where the Reader's other half has the least to work with — no request, no
  # controller — and it is also the first thing a developer sees after a restart. The line
  # below is logged while Rails is still loading initializers, which is the earliest this
  # sink can possibly be attached: `z_` sorts after `rails_log_reader`.
  test "a line logged at boot, with no request in flight, is unattributed rather than dropped" do
    run = DevelopmentRun.boot do |root|
      File.write(File.join(root, "config/initializers/z_logs_at_boot.rb"),
        %(Rails.logger.warn("nothing is in flight yet")))
    end

    assert run.booted?, run.output
    assert_empty run.events_of("request_start"), "nothing was in flight, which is the case being covered"
    line = app_log(run, "nothing is in flight yet")

    assert line, "a line with no owning request never reached the Sidecar"
    assert_nil line["request_id"], "its Run owns it — being homeless is what unattributed is not"
    assert_equal "warn", line["payload"]["severity"]
    assert_equal "app", line["payload"]["source"]
    assert_operator run.events_of("run_header").sole["seq"], :<, line["seq"]
  end

  # The sink is last in the broadcast, so it is the last to be handed a block — and
  # BroadcastLogger#dispatch memoises that block rather than re-running it, which means
  # whoever runs it *first* pays for it. When the app's own log_level suppresses the line,
  # nothing before us runs it, and a sink that yielded anyway would make dead code live: the
  # `expensive` in `logger.debug { expensive }` starts costing again, and a raise inside one
  # reaches the developer's request through a debugging tool. Measured both ways.
  test "a block the rest of the broadcast never runs is not run here either" do
    run = DevelopmentRun.boot(script: <<~RUBY)
      Rails.logger.level = Logger::INFO
      blocks = 0
      Rails.logger.debug { blocks += 1; "a suppressed debug line" }
      Rails.logger.info { blocks += 1; "an info line built by a block" }
      begin
        Rails.logger.debug { raise "a block that should have stayed dead code" }
        puts "no raise reached the caller"
      rescue StandardError => e
        puts "RAISED INTO THE APP: \#{e.message}"
      end
      puts "blocks_run=\#{blocks}"
    RUBY

    assert run.booted?, run.output
    assert_includes run.output, "no raise reached the caller"
    assert_includes run.output, "blocks_run=1", "a block the app had suppressed was run anyway"

    assert_nil app_log(run, "a suppressed debug line"),
      "no message could be read without running the block, so there is no event to write"
    assert app_log(run, "an info line built by a block"),
      "a block the broadcast did run is already memoised, and reading it costs the app nothing"
  end

  # The other half of the same promise as the tagged-sink one: `formatter=` and `level=` are
  # both dispatched to every sink, so configuring ours through the broadcast would reconfigure
  # development.log's. Nothing here does, and the way to show it is to ask the broadcast what
  # it says about itself with the sink attached and without it.
  BROADCAST = <<~RUBY
    require "json"
    puts JSON.generate(
      sinks: Rails.logger.broadcasts.size,
      level: Rails.logger.level,
      predicates: %w[debug info warn error fatal].index_with { |level| Rails.logger.public_send("\#{level}?") },
      formatter: Rails.logger.formatter.class.name,
      tagged: Rails.logger.formatter.respond_to?(:current_tags),
      first_sink: Rails.logger.broadcasts.first.class.name,
      first_sink_level: Rails.logger.broadcasts.first.level,
      first_sink_formatter: Rails.logger.broadcasts.first.formatter.class.name
    )
  RUBY

  test "the sink changes nothing the broadcast says about itself but the number of sinks" do
    attached = DevelopmentRun.boot(script: BROADCAST)
    absent = DevelopmentRun.boot(script: BROADCAST, initializer: false)

    assert attached.booted?, attached.output
    assert absent.booted?, absent.output

    with = JSON.parse(attached.output)
    without = JSON.parse(absent.output)

    assert_equal without["sinks"] + 1, with["sinks"], "no sink was attached, so this proves nothing"
    assert_equal without.except("sinks"), with.except("sinks")
  end

  test "every severity arrives under its own name, including the one << never states" do
    run = DevelopmentRun.boot(script: <<~RUBY)
      %w[debug info warn error fatal].each { |level| Rails.logger.public_send(level, "line at \#{level}") }
      Rails.logger << "a line written straight to the device"
    RUBY

    assert run.booted?, run.output
    severities = %w[debug info warn error fatal].to_h do |level|
      [ level, app_log(run, "line at #{level}")&.dig("payload", "severity") ]
    end

    assert_equal %w[debug info warn error fatal].index_with { |level| level }, severities
    assert_equal "unknown", app_log(run, "a line written straight to the device")["payload"]["severity"],
      "<< bypasses add and every severity there is, and `unknown` is the honest answer"
  end

  # #33: `Rails.logger.info(blob)` is all it takes — a message this file never controls the
  # encoding of. Before #33, JSON.generate raised inside `emit` on the bad byte, and the
  # rescue there disabled the Run silently for everything after it, not just the one line.
  test "a Run that logs a non-UTF-8 message keeps emitting afterwards" do
    run = DevelopmentRun.boot(script: <<~'RUBY')
      Rails.logger.info("hello \xff\xfe world".b)
      Rails.logger.info("still going")
    RUBY

    assert run.booted?, run.output
    messages = run.events_of("app_log").map { |event| event["payload"]["message"] }

    bad = messages.find { |message| message.start_with?("<") }
    assert bad, "the non-UTF-8 line never reached the Sidecar:\n#{messages.inspect}"
    assert_match(/\A<\d+ bytes of binary data>\z/, bad)

    assert_includes messages, "still going",
      "one bad byte disabled the Run for everything after it, which is the bug #33 fixes"
  end

  # `verbose_query_logs`, colourised SQL and every other Rails line arrive wrapped in escape
  # codes, because a terminal is what reads development.log. The Reader is not a terminal, so
  # they are removed rather than carried through for a renderer to interpret later.
  test "ANSI is stripped from the message and never reaches the Sidecar" do
    run = DevelopmentRun.boot(script: DevelopmentRun.real_request("/posts"))

    assert run.booted?, run.output
    assert_includes run.development_log, "\e[", "this Run logged nothing colourised, so it proves nothing"
    assert_not_includes run.sidecar_bytes, "\e",
      "an escape byte reached the Sidecar, where nothing will ever interpret it"

    query_line = app_log(run) { |message| message.include?("Post Load") }
    assert query_line, "the colourised SQL line never reached the Sidecar at all"
    assert_match(/\APost Load \(\d/, query_line["payload"]["message"].strip,
      "stripping the colour has to leave the line itself readable")
  end

  # The team that invested most in logging is the one this would otherwise serve worst.
  test "a team's own log_tags reach the Reader, custom ones included" do
    run = boot_logging_request("/posts") { |root| with_log_tags(root) }

    assert run.booted?, run.output
    request_id = run.events_of("request_start").sole["request_id"]
    line = app_log(run, "a line from inside the request")

    assert line, "the controller's own log line never reached the Sidecar"
    assert_equal [ request_id, "tenant-42" ], line["payload"]["tags"],
      "read off the formatter development.log is being written with, so whatever it has, we have"
    assert_includes run.development_log, "[#{request_id}] [tenant-42] a line from inside the request",
      "and the file itself still gets them, which is the accounting we must not have touched"
  end

  # The hazard the sink is shaped around, and the reason it is a plain ::Logger. A
  # BroadcastLogger dispatches `tagged` through method_missing, which forwards to *every*
  # sink that responds and does not memoise the block — so a second tagged sink would run the
  # block twice and pop two tags for one push, leaving development.log with the line twice,
  # once tagged and once not. Measured against the Example app before the sink was written.
  test "a tagged block runs once and leaves the tag stack exactly as it found it" do
    run = DevelopmentRun.boot(script: <<~RUBY)
      blocks = 0
      Rails.logger.tagged("Scenario") { blocks += 1; Rails.logger.info("a tagged line") }
      puts "blocks=\#{blocks} left_behind=\#{Rails.logger.formatter.current_tags.inspect}"
    RUBY

    assert run.booted?, run.output
    assert_includes run.output, "blocks=1 left_behind=[]"
    assert_equal [ "[Scenario] a tagged line" ], run.development_log.lines.grep(/a tagged line/).map(&:chomp),
      "one line, tagged once: two responders to `tagged` would have written it twice"
    assert_equal [ "Scenario" ], app_log(run, "a tagged line")["payload"]["tags"]
  end

  private
    def boot_logging_request(path, &shape)
      DevelopmentRun.boot(script: DevelopmentRun.real_request(path)) do |root|
        File.write(File.join(root, "config/initializers/z_logs_in_request.rb"), LOGS_IN_REQUEST)
        shape&.call(root)
      end
    end

    # A `log_tags` of the shape a Work app actually configures: the request id every generated
    # production.rb already sets, and a lambda beside it, which is where a team's own tags come
    # from and the reason none of this can be a fixed list of fields.
    def with_log_tags(root)
      path = File.join(root, "config/environments/development.rb")
      File.write(path, File.read(path).sub(
        "config.enable_reloading = true",
        %(config.enable_reloading = true\n  config.log_tags = [ :request_id, ->(request) { "tenant-42" } ])
      ))
    end

    def app_log(run, message = nil)
      run.events_of("app_log").find do |event|
        text = event["payload"]["message"]
        block_given? ? yield(text) : text == message
      end
    end
end
