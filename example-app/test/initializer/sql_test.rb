require "test_helper"
require "support/development_run"

# `sql.active_record`, the busiest event on the wire and the whole substance of the Detail
# column. Driven through real, booted Runs wherever the Example app's own database can
# produce the payload — and where it cannot, which is more often than it sounds, the reason
# is written down at the test that says so.
class SqlTest < ActiveSupport::TestCase
  test "every query a request runs is attributed to it, and carries what the Detail column renders" do
    run = DevelopmentRun.boot(script: DevelopmentRun.real_request("/posts"))

    assert run.booted?, run.output
    start = run.events_of("request_start").sole
    finish = run.events_of("request_finish").sole
    queries = run.events_of("sql")

    assert_equal [start["request_id"]], queries.map { |query| query["request_id"] }.uniq,
      "every query this Run ran was issued by the one request that ran it"
    assert_operator queries.first["seq"], :>, start["seq"]
    assert_operator queries.last["seq"], :<, finish["seq"]
    assert queries.any? { |query| query["payload"]["name"] == "SCHEMA" },
      "Rails' own log subscriber drops SCHEMA queries; a Reader that did too could never " \
      "answer why the first request after a boot was the slow one"

    posts = queries.find { |query| query["payload"]["name"] == "Post Load" }
    assert posts, "the query the page is made of never reached the Sidecar"

    payload = posts["payload"]
    assert_match(/\ASELECT "posts"\.\* FROM "posts"/, payload["sql"])
    assert_match(%r{/\*action='index',application='ExampleApp',controller='posts'\*/}, payload["sql"],
      "the SQL goes as emitted, QueryLogs comment and all")
    assert_operator payload["duration_ms"], :>, 0
    assert_equal false, payload["cached"]
    assert_equal false, payload["async"]
    assert_operator payload["row_count"], :>, 0
    assert_equal [], payload["binds"]
  end

  # The impoverished payload, and the one a Reader that assumed a model would break on.
  test "a raw connection.execute is a well-formed event with a nil name and no binds" do
    run = DevelopmentRun.boot(script: %(ActiveRecord::Base.connection.execute("SELECT 1")))

    assert run.booted?, run.output
    query = run.events_of("sql").find { |event| event["payload"]["sql"].start_with?("SELECT 1") }

    assert query, "the raw query never reached the Sidecar:\n#{run.sidecar_bytes}"
    assert_nil query["request_id"], "nothing issued it but the Run itself"

    payload = query["payload"]
    assert_nil payload["name"], "a raw execute names nothing, and nil is the honest answer"
    assert_equal [], payload["binds"],
      "no binds is an ordinary empty array — the normal case on mysql2 and trilogy too"
    assert_equal false, payload["cached"]
    assert_equal false, payload["async"]
    assert_operator payload["duration_ms"], :>, 0
  end

  test "a bind matching the app's own filter_parameters never reaches the Sidecar" do
    run = DevelopmentRun.boot(script: %(Author.find_by(email: "someone@example.com"))) do |root|
      with_prepared_statements(root)
    end

    assert run.booted?, run.output
    query = run.events_of("sql").find { |event| event["payload"]["name"] == "Author Load" }
    assert query, "the query carrying the bind never reached the Sidecar"

    assert_equal [ "[FILTERED]", 1 ], query["payload"]["binds"],
      "email is in this app's filter_parameters, and the LIMIT beside it is not"
    assert_not_includes run.sidecar_bytes, "someone@example.com",
      "development.log would have redacted it, so a file we wrote instead must not carry it"
  end

  # The query cache re-instruments a hit with `type_casted_binds` as a lazy Proc rather than
  # an array, so a subscriber that only ever indexes it gets the Proc itself — or, worse,
  # calls it in one place and not the other and shows a CACHE line with no values.
  test "a query-cache hit carries its bind values, which arrive as a lazy Proc" do
    twice = %(ActiveRecord::Base.cache { 2.times { Author.find_by(email: "someone@example.com") } })
    run = DevelopmentRun.boot(script: twice) { |root| with_prepared_statements(root) }

    assert run.booted?, run.output
    loads = run.events_of("sql").select { |event| event["payload"]["name"] == "Author Load" }
    assert_equal 2, loads.size, "the cache re-instruments the hit rather than staying silent"
    ran, cached = loads.map { |event| event["payload"] }

    assert_equal false, ran["cached"]
    assert_equal true, cached["cached"]
    assert_equal ran["binds"], cached["binds"], "a hit's values are the values it was a hit for"
    assert_equal [ "[FILTERED]", 1 ], cached["binds"]
  end

  # `load_async` is instrumented on a background thread and replayed on the request thread by
  # ActiveRecord::FutureResult::EventBuffer#flush, which publishes the finished Event instead
  # of calling start and finish. Fanout hands that to a subscriber's own `publish_event` if
  # it has one, and otherwise to `publish`, which this file does not define — so a subscriber
  # missing the method loses every async query without a word. The Example app cannot drive
  # the real path: `load_async` needs `config.active_record.async_query_executor`, which no
  # generated app sets, and even with one the calling thread usually wins the race and runs
  # the query itself. So the replay is driven exactly the way the EventBuffer drives it —
  # down to the `lock_wait` it stamps on first, which Rails' own runtime registry reads and
  # raises without — because that dispatch is the seam that can break.
  test "a finished Event replayed through publish_event still reaches the Sidecar" do
    run = DevelopmentRun.boot(script: <<~RUBY)
      event = ActiveSupport::Notifications::Event.new("sql.active_record", nil, nil, "async", {
        sql: "SELECT 1", name: "Post Load", binds: [], type_casted_binds: [],
        async: true, row_count: 54, lock_wait: 0.0
      })
      event.record { }
      sleep 0.1
      ActiveSupport::Notifications.publish_event(event)
    RUBY

    assert run.booted?, run.output
    query = run.events_of("sql").sole
    payload = query["payload"]

    assert_equal "Post Load", payload["name"]
    assert_equal true, payload["async"]
    assert_equal 54, payload["row_count"]
    assert_operator payload["duration_ms"], :>=, 0

    # The one place ADR-0002 says the two orderings are allowed to disagree, and the reason
    # the envelope carries both: `seq` counts this replay, while `at_mono` has to be the
    # moment the query was actually issued — a tenth of a second earlier, here, by
    # construction. A Reader given only the replay time could never draw the true order.
    ending = run.events_of("run_end").sole
    assert_operator query["seq"], :<, ending["seq"], "seq counts the replay, in replay order"
    assert_operator ending["at_mono"] - query["at_mono"], :>, 90_000_000,
      "at_mono was stamped when the replay was written rather than when the query was issued"
  end

  # Rails 7.1 and 7.2 carry neither `:row_count` nor `:transaction` in this payload. Absent
  # is absence, not error: the field is simply not sent, and the wire contract has it
  # optional. There is no 7.1 here to run, so what is driven is a 7.1-shaped payload through
  # the real notification the real subscriber is listening to.
  test "a payload with no row_count is emitted without one rather than refused" do
    run = DevelopmentRun.boot(script: <<~RUBY)
      ActiveSupport::Notifications.instrument("sql.active_record",
        sql: "SELECT 1", name: "Post Load", binds: [], type_casted_binds: [], async: false)
    RUBY

    assert run.booted?, run.output
    query = run.events_of("sql").sole

    assert_not query["payload"].key?("row_count"), "an absent field is not sent, not sent as null"
    assert_equal "Post Load", query["payload"]["name"]
    assert_equal [], query["payload"]["binds"]
  end

  # sqlite3 type-casts every bind down to nil, a String or a Numeric before this file can see
  # it, so the values #13 warned about — the ones JSON.generate raises on, which would cost
  # the Run every event after them — cannot be produced by a real query here. They are handed
  # to the real notification by hand instead.
  test "a bind that is not a JSON primitive is serialized rather than left to break the append" do
    run = DevelopmentRun.boot(script: <<~'RUBY')
      binds = %w[created_at avatar price ratio].map do |name|
        ActiveRecord::Relation::QueryAttribute.new(name, nil, ActiveModel::Type::Value.new)
      end
      ActiveSupport::Notifications.instrument("sql.active_record",
        sql: "SELECT 1", name: "Odd Load", binds: binds, type_casted_binds: [
          Time.utc(2026, 9, 5, 12, 0, 0), "\xff\xfe".b, BigDecimal("1.5"), Float::INFINITY
        ])
    RUBY

    assert run.booted?, run.output
    payload = run.events_of("sql").sole["payload"]

    # `1.5` rather than BigDecimal's own `0.15e1`, because ActiveSupport makes "F" the
    # default format of BigDecimal#to_s — so the plainest possible rule gives the good
    # answer here without this file knowing anything about decimals.
    assert_equal [ "2026-09-05T12:00:00.000Z", "<2 bytes of binary data>", "1.5", "Infinity" ],
      payload["binds"]
  end

  # The `↳` line `verbose_query_logs` prints under a query is the one place a developer
  # already reads where a query came from, so the callsite is asked of the very cleaner that
  # line is printed through, and has to come out byte for byte the same.
  test "a query's callsite is the ↳ line Rails prints for it, relative to the app root" do
    run = DevelopmentRun.boot(script: DevelopmentRun.real_request("/posts"))

    assert run.booted?, run.output
    posts = run.events_of("sql").find { |event| event["payload"]["name"] == "Post Load" }
    assert posts, "the query the page is made of never reached the Sidecar"
    arrow = run.events_of("app_log").find do |event|
      event["seq"] > posts["seq"] && event["payload"]["message"].lstrip.start_with?("↳ ")
    end
    assert arrow, "verbose_query_logs is on in this app, so the query has a ↳ line"

    callsite = posts["payload"]["callsite"]
    assert_equal arrow["payload"]["message"].lstrip.delete_prefix("↳ "), callsite
    assert_match %r{\Aapp/views/posts/index\.html\.erb:\d+}, callsite
  end

  # This file sits under config/initializers/, which the cleaner lets through as app code —
  # so a query issued from anywhere the cleaner silences would otherwise be credited to the
  # Initializer's own `record`. A runner script at the app root is such a place, and has no
  # ↳ line either.
  test "a query issued from outside the app's own directories has no callsite, never this file's frame" do
    run = DevelopmentRun.boot(script: "Post.first")

    assert run.booted?, run.output
    query = run.events_of("sql").find { |event| event["payload"]["name"] == "Post Load" }
    assert query, "the query never reached the Sidecar"

    assert_not query["payload"].key?("callsite"), "absent, exactly as it has no ↳ line"
    callsites = run.events.filter_map { |event| event["payload"]["callsite"] if event["payload"].is_a?(Hash) }
    assert_empty callsites.grep(/rails_log_reader/), "the Initializer is never where anything came from"
  end

  # The replay runs on whatever stack flushed the buffer, which says nothing about the code
  # that issued the query. Replayed from an initializer here so that a stack walk would have a
  # clean frame to find, and be wrong.
  test "a finished Event replayed through publish_event carries no callsite" do
    run = DevelopmentRun.boot do |root|
      File.write(File.join(root, "config/initializers/z_replays_async.rb"), <<~RUBY)
        event = ActiveSupport::Notifications::Event.new("sql.active_record", nil, nil, "async", {
          sql: "SELECT 1", name: "Post Load", binds: [], type_casted_binds: [],
          async: true, row_count: 54, lock_wait: 0.0
        })
        event.record { }
        ActiveSupport::Notifications.publish_event(event)
      RUBY
    end

    assert run.booted?, run.output
    query = run.events_of("sql").find { |event| event["payload"]["sql"] == "SELECT 1" }
    assert query, "the replayed query never reached the Sidecar"
    assert_not query["payload"].key?("callsite")
  end

  private
    # The Example app cannot produce a bind on its own. `query_log_tags_enabled` is on in
    # every generated Rails 8 development.rb — it is why our `sql` carries a QueryLogs
    # comment at all — and Rails answers it by disabling prepared statements process-wide,
    # after which Arel substitutes every value into the SQL string and `binds` is empty for
    # the whole Run. A Work app with query log tags off is where binds actually come from,
    # so that is the app these Runs shape themselves into.
    def with_prepared_statements(root)
      path = File.join(root, "config/environments/development.rb")
      File.write(path, File.read(path).sub(
        "config.active_record.query_log_tags_enabled = true",
        "config.active_record.query_log_tags_enabled = false"
      ))
    end
end
