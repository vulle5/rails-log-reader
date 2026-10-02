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
    assert_select "button[data-scenario=?]", scenario_json_path
    assert_select "button[data-scenario=?]", scenario_xml_path
    assert_select "button[data-scenario=?]", scenario_big_json_path
    assert_select "button[data-scenario=?]", scenario_streamed_csv_path
    assert_select "button[data-scenario=?]", scenario_gzip_json_path
    assert_select "button[data-scenario=?]", scenario_pdf_path
    assert_select "button[data-scenario=?]", scenario_no_content_path
    assert_select "button[data-scenario=?]", scenario_redirect_path
    assert_select "button[data-scenario=?]", scenario_hijack_path
  end

  test "the 304's button sends the If-Modified-Since that makes it one" do
    get scenarios_path

    assert_select "button[data-scenario=?][data-headers=?]", scenario_conditional_get_path,
      { "If-Modified-Since" => ScenariosController::UNCHANGED_SINCE.httpdate }.to_json
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

  test "scenario 15: json — a JSON body" do
    get scenario_json_path

    assert_response :success
    assert_equal "application/json", response.media_type
    assert_kind_of Array, response.parsed_body["posts"]
  end

  test "scenario 16: xml — an XML body" do
    get scenario_xml_path

    assert_response :success
    assert_equal "application/xml", response.media_type
    assert_match(/\A<\?xml version="1.0" encoding="UTF-8"\?>\n<posts>/, response.body)
  end

  test "scenario 17: big_json — a JSON body over 64 KB" do
    get scenario_big_json_path

    assert_response :success
    assert_equal "application/json", response.media_type
    assert_operator response.body.bytesize, :>, 64 * 1024
  end

  test "scenario 18: streamed_csv — a CSV body that is never whole in memory" do
    get scenario_streamed_csv_path

    assert_response :success
    assert_equal "text/csv", response.media_type
    assert_match(/\Aid,title,comments\n\d+,/, response.body)
  end

  test "scenario 19: gzip_json — a JSON body the app gzipped itself" do
    get scenario_gzip_json_path

    assert_response :success
    assert_equal "gzip", response.headers["content-encoding"]
    assert_equal "application/json", response.media_type
    assert_kind_of Array, JSON.parse(ActiveSupport::Gzip.decompress(response.body))["posts"]
  end

  test "scenario 20: pdf — a PDF sent from disk" do
    get scenario_pdf_path

    assert_response :success
    assert_equal "application/pdf", response.media_type
    assert_equal File.binread(ScenariosController::REPORT_PDF), response.body
  end

  test "scenario 21: no_content — a 204" do
    get scenario_no_content_path

    assert_response :no_content
    assert_empty response.body
  end

  test "scenario 22: conditional_get — a 304 when unchanged since the date it is sent, and a 200 without one" do
    get scenario_conditional_get_path, headers: { "If-Modified-Since" => ScenariosController::UNCHANGED_SINCE.httpdate }
    assert_response :not_modified

    get scenario_conditional_get_path
    assert_response :success
  end

  test "scenario 23: redirect — a 302 to Scenario 15" do
    get scenario_redirect_path

    assert_redirected_to scenario_json_path
  end

  test "scenario 24: hijack — writes its own reply to the socket it takes, and closes it" do
    socket = StringIO.new
    get scenario_hijack_path, env: { "rack.hijack?" => true, "rack.hijack" => -> { socket } }

    assert_equal ScenariosController::HIJACKED_REPLY, socket.string
    assert socket.closed?
  end
end
