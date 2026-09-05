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
end
