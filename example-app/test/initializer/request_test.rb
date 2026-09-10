require "test_helper"
require "support/development_run"

# The middleware inserted after ActionDispatch::RequestId, and the three subscribers that
# turn one HTTP request into request_start, request_route and request_finish. Exercised the
# only way that actually proves the wiring: one real request through a real, booted app.
class RequestTest < ActiveSupport::TestCase
  test "one real request writes request_start, request_route and request_finish, sharing one request_id, in order" do
    run = DevelopmentRun.boot(script: DevelopmentRun.real_request("/posts"))

    assert run.booted?, run.output
    # By type rather than by position in the file: since #20 the request's own queries sit
    # between these three, which is the entire point of them. `sole` is the assertion that
    # there is exactly one of each.
    start = run.events_of("request_start").sole
    route = run.events_of("request_route").sole
    finish = run.events_of("request_finish").sole

    assert_match(/\A[0-9a-f-]{36}\z/, start["request_id"])
    assert_equal [start["request_id"]] * 3, [start, route, finish].map { |event| event["request_id"] },
      "all three belong to the one request they narrate"
    assert_operator start["seq"], :<, route["seq"]
    assert_operator route["seq"], :<, finish["seq"]

    assert_equal({ "method" => "GET", "path" => "/posts" }, start["payload"])
    assert_equal "PostsController", route["payload"]["controller"]
    assert_equal "index", route["payload"]["action"]
    assert_equal "html", route["payload"]["format"]
    assert_equal 200, finish["payload"]["status"]
    assert_operator finish["payload"]["duration_ms"], :>, 0
    assert finish["payload"]["view_runtime_ms"], "a page that rendered a view should say how long it took"
    assert finish["payload"]["db_runtime_ms"], "a page that queried the database should say how long it took"
    assert_nil finish["payload"]["exception"], "nothing went wrong, so there is nothing to report"
  end

  test "request_route's params have already been run through the app's own filter_parameters" do
    run = DevelopmentRun.boot(script: DevelopmentRun.real_request("/posts", params: { password: "hunter2" }))

    assert run.booted?, run.output
    params = run.events_of("request_route").sole["payload"]["params"]

    assert_equal "[FILTERED]", params["password"],
      "filter_parameters is the app's own list (config/initializers/filter_parameter_logging.rb), not ours"
  end

  # request_route only fires once a controller is entered, so its absence is the whole signal
  # a routing failure gives — there is no fourth event announcing "this one didn't route".
  test "a request to an unroutable path gets a request_start and a request_finish, and no request_route" do
    run = DevelopmentRun.boot(script: DevelopmentRun.real_request("/no/such/route"))

    assert run.booted?, run.output
    assert_empty run.events_of("request_route")

    start = run.events_of("request_start").sole
    finish = run.events_of("request_finish").sole
    assert_equal start["request_id"], finish["request_id"]
    assert_equal 404, finish["payload"]["status"]
  end

  # A real, unhandled exception — Post.find raising on a row that was never seeded — rather
  # than a synthetic one, so this proves the actual path: process_action.action_controller's
  # exception_object, handed off through Current to the request.action_dispatch subscriber.
  test "an exception the controller raises is reported with its class, message and full backtrace" do
    run = DevelopmentRun.boot(script: DevelopmentRun.real_request("/posts/999999999"))

    assert run.booted?, run.output
    route = run.events_of("request_route").sole
    finish = run.events_of("request_finish").sole

    assert_equal "PostsController", route["payload"]["controller"], "routing itself succeeded"
    assert_equal 404, finish["payload"]["status"]

    exception = finish["payload"]["exception"]
    assert_equal "ActiveRecord::RecordNotFound", exception["class"]
    assert_match(/Post/, exception["message"])
    assert_operator exception["backtrace"].size, :>, 0
    assert_nil finish["payload"]["view_runtime_ms"], "the view never rendered"
    assert_nil finish["truncated"], "a real backtrace is nowhere near the caps this Run enforces"
  end

  # #33: ActionDispatch does not guarantee valid UTF-8 in a query string or a multipart
  # field, but by the time a request of this Example app's own shape reaches a controller,
  # Rails has already 400'd anything that fails its own recursive encoding check
  # (Request::Utils.check_param_encoding) — so no request this app can make actually gets an
  # invalid byte this far. What #33 protects against reaches `start_processing.action_controller`
  # by a route Rails' check does not cover at all (a multipart upload's filename is force-encoded,
  # never validated, in ActionDispatch::Http::UploadedFile#initialize), so this drives the real
  # subscriber with the payload shape that route produces — same as SqlTest's own "handed to the
  # real notification by hand" bind test, for the same reason.
  test "a param carrying an invalid UTF-8 byte still produces a well-formed request_route, and the Run keeps emitting after it" do
    run = DevelopmentRun.boot(script: <<~'RUBY')
      ActiveSupport::Notifications.instrument("start_processing.action_controller",
        controller: "PostsController", action: "index", format: "html",
        params: { "q" => "hello \xff\xfe world".dup.force_encoding("UTF-8") })
      RailsLogReader.emit("request_finish", { status: 200, duration_ms: 1.0 })
    RUBY

    assert run.booted?, run.output
    route = run.events_of("request_route").sole

    assert_equal "hello  world", route["payload"]["params"]["q"],
      "readable text keeps what can be read, same as cut_string's own scrub"
    assert run.events_of("request_finish").sole, "one bad byte disabled the Run for the finish after it"
  end

  # #45: `RailsLogReader::Current` was an ActiveSupport::CurrentAttributes, and Rails clears
  # every one of those from `reloader.before_class_unload` — which, our middleware sitting
  # above ActionDispatch::Reloader, runs *inside* the request that triggered the reload.
  # Everything after it read a nil request_id, and the finish was dropped outright, in
  # silence, when `duration_ms` subtracted the nil start. The first request after any edit is
  # a routine moment in a dev tool, not an edge case.
  #
  # Two requests, because that is what it takes: the first is what loads the routes and gives
  # the file watcher its baseline, the edit comes after it, and the second request is the one
  # under test — which is exactly the sequence the issue reproduces by hand.
  test "a request that reloads the app's classes keeps its request_id throughout, and still finishes" do
    run = DevelopmentRun.boot(script: <<~RUBY)
      #{DevelopmentRun.real_request("/posts")}

      # What a developer does between two requests: edit a file the app watches. `config/` is
      # this Run's own copy while `app/` is a symlink to the Example app's own, so routes.rb
      # is the one watched file a test can touch without editing the app the suite shares.
      FileUtils.touch(Rails.root.join("config/routes.rb"))

      # The precondition, proved rather than assumed: a test that quietly stopped reloading
      # would go on passing every assertion below while testing nothing.
      unloaded = false
      Rails.application.reloader.before_class_unload { unloaded = true }

      #{DevelopmentRun.real_request("/posts")}

      puts "classes unloaded during the second request: \#{unloaded}"
    RUBY

    assert run.booted?, run.output
    assert_includes run.output, "classes unloaded during the second request: true",
      "the request under test has to be one that actually reloaded"

    start = run.events_of("request_start").last
    finish = run.events_of("request_finish").find { |event| event["seq"] > start["seq"] }
    assert finish, "the reloading request finished — Rails said `Completed 200 OK` — so the file has to say so"

    within = run.events.select { |event| event["seq"].between?(start["seq"] + 1, finish["seq"] - 1) }
    refute_empty within, "the request emitted a `Started GET` line and its queries, at the very least"
    assert_equal [start["request_id"]], within.map { |event| event["request_id"] }.uniq,
      "everything emitted between the request's own two ends belongs to it"
    assert_equal start["request_id"], finish["request_id"]
    assert_equal "PostsController", run.events_of("request_route").last["payload"]["controller"]
    assert_equal 200, finish["payload"]["status"]
    assert_operator finish["payload"]["duration_ms"], :>, 0
  end

  # The other half of #45, and the backstop under it: a finish is a fact, and the one field
  # it cannot measure is the one that used to take the whole event down with it. Driven
  # through the real notification without the middleware ever running, which is the shape a
  # request whose start this file never saw actually has.
  test "a request_finish with no start recorded is still emitted, and says nothing about duration" do
    run = DevelopmentRun.boot(script: <<~RUBY)
      ActiveSupport::Notifications.instrument("request.action_dispatch", request: nil) { }
    RUBY

    assert run.booted?, run.output
    finish = run.events_of("request_finish").sole

    assert_nil finish["request_id"]
    refute finish["payload"].key?("duration_ms"),
      "a duration this file cannot measure is absent, never a zero that would read as instant"
  end

  # What `ActiveSupport::CurrentAttributes` used to give for free, and what holding the
  # request context in `ActiveSupport::IsolatedExecutionState` has to pay for by hand: the
  # thread that served a request goes on to serve others, and a request_id left behind on it
  # would attribute their events — and every unattributed line in between — to a request that
  # is over.
  test "the request context is cleared when the request completes, so what the thread does next is unattributed" do
    run = DevelopmentRun.boot(script: <<~RUBY)
      #{DevelopmentRun.real_request("/posts")}
      Rails.logger.info("after the request, on the same thread")
    RUBY

    assert run.booted?, run.output
    after = run.events_of("app_log").find { |event| event["payload"]["message"].include?("after the request") }

    assert after, "the line was written, so it is somewhere in the file"
    assert_nil after["request_id"], "its Run owns it, not the request that happened to run before it"
  end

  # Puma's own C extension hands `request.request_method` over BINARY-tagged
  # (`rb_str_new` with no encoding, right beside header values the same extension does tag
  # UTF-8) even though every HTTP method is plain ASCII — a mislabel, not a blob. #33's scrub
  # used to treat the tag alone as proof of opaque binary, so every method on a real,
  # Puma-served request read back as `<3 bytes of binary data>`. Session's Integration
  # request builds its own env in Ruby rather than through Puma's parser, so this drives the
  # middleware with a hand-built env carrying the same tag Puma's actually would.
  test "a BINARY-tagged request method that is plain ASCII is not mistaken for opaque binary" do
    run = DevelopmentRun.boot(script: <<~'RUBY')
      require "rack/mock_request"
      env = Rack::MockRequest.env_for("/posts")
      env["REQUEST_METHOD"] = "GET".dup.force_encoding(Encoding::BINARY)
      RailsLogReader::Middleware.new(->(_env) { [ 200, {}, [ "" ] ] }).call(env)
    RUBY

    assert run.booted?, run.output
    assert_equal "GET", run.events_of("request_start").sole["payload"]["method"]
  end
end
