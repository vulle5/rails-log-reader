require "test_helper"
require "active_record/testing/query_assertions"

# `/scenarios` exists to be curled, not clicked — the acceptance criterion the assertions
# below are built around. Every action is a plain GET with no side effect worth naming, so an
# ordinary integration test doubles as the proof that `curl` reaches the same code a browser
# button would.
class ScenariosControllerTest < ActionDispatch::IntegrationTest
  include ActiveRecord::Assertions::QueryAssertions

  test "the index page links every scenario, unfiltered from its own traffic" do
    get scenarios_path

    assert_response :success
    assert_select "button[data-scenario=?]", scenario_parallel_path
    assert_select "button[data-scenario=?]", scenario_n_plus_one_path
    assert_select "button[data-scenario=?]", scenario_slow_query_path
    assert_select "button[data-scenario=?]", scenario_hang_path
    assert_select "button[data-scenario=?]", scenario_error_path
    assert_select "button[data-scenario=?]", scenario_dual_homing_path
    assert_select "button[data-scenario=?]", scenario_raw_sql_path
    assert_select "button[data-scenario=?]", scenario_flood_path
    assert_select "button[data-scenario=?]", scenario_partial_request_path
    assert_select "button[data-scenario=?]", scenario_trailing_event_path
  end

  # 8, 10 (twice) 12 and 14 get no button — none of them is a path a browser can fetch — so
  # this is the one place their reachability is actually checked at all.
  test "the index page also shows a copy-pasteable command for every Scenario that has no button" do
    get scenarios_path

    assert_response :success
    assert_select "pre code", text: /bin\/rake scenarios:rake_burst/
    assert_select "pre code", text: /kill -9 \$SERVER_PID/
    assert_select "pre code", text: /kill -TERM \$SERVER_PID/
    assert_select "pre code", text: /WEB_CONCURRENCY=2 bin\/dev/
    assert_select "pre code", text: /bin\/rake scenarios:long_task/
  end

  test "scenario 1: parallel — a plain request, ready to be fired several at once" do
    get scenario_parallel_path

    assert_response :success
  end

  test "scenario 2: n_plus_one — one query for the parents, one per child" do
    # The fixtures are small on purpose; the shape — one query, then one per row — is what
    # this test is for, not the ~50 children the AC describes against the seeded dev database.
    expected_queries = 1 + Comment.count

    assert_queries_count(expected_queries) { get scenario_n_plus_one_path }
    assert_response :success
  end

  test "scenario 3: slow_query — a recursive CTE, not a Ruby sleep" do
    get scenario_slow_query_path

    assert_response :success
    assert_match(/\Atotal=\d+\z/, response.body)
  end

  # The hang has no test of its own: it never returns, and a test that called it would hang
  # too. `assert_routing` below confirms the endpoint exists without ever dispatching to it.
  test "scenario 4: hang — routes, but is never dispatched here" do
    assert_routing({ path: "/scenarios/hang", method: :get }, controller: "scenarios", action: "hang")
  end

  # Test env raises rather than rendering — `config.action_dispatch.show_exceptions =
  # :rescuable`, and a plain RuntimeError is not one Rails knows how to rescue. In
  # development this is the page `consider_all_requests_local` renders with a full
  # backtrace; here the same exception, still carrying its message, is the observable proof.
  test "scenario 5: error — a deliberate, unhandled exception with a real backtrace" do
    error = assert_raises(RuntimeError) { get scenario_error_path }

    assert_match(/Scenario 5/, error.message)
    assert_not_empty error.backtrace
  end

  test "scenario 6: dual_homing — a Rails.logger call between two queries" do
    assert_queries_count(2) { get scenario_dual_homing_path }

    assert_response :success
  end

  test "scenario 7: raw_sql — connection.execute, no model, no binds, a nil name" do
    get scenario_raw_sql_path

    assert_response :success
    assert_match(/\Atotal=\d+\z/, response.body)
  end

  test "scenario 9: flood — a single cheap query, meant to be fired ~20 at once" do
    get scenario_flood_path

    assert_response :success
  end

  # The 2-second pause between its two queries is the point — see the README for what
  # happens to the Sidecar in that window against a real Run — but this test only has this
  # app's own database to talk to, so all it can prove is that the request itself completes.
  test "scenario 11: partial_request — two queries either side of a pause" do
    assert_queries_count(2) { get scenario_partial_request_path }

    assert_response :success
  end

  # TrailingEventMiddleware's own close-block work happens after the response is sent, which
  # an integration test that never inspects the Sidecar cannot observe — TrailingTest does.
  # This is the routing-and-response half only.
  test "scenario 13: trailing_event — routes and responds; TrailingTest proves what its close block does" do
    get scenario_trailing_event_path

    assert_response :success
  end
end
