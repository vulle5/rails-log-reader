# The traffic shapes the Reader exists to make readable, one action per Scenario. `index`
# is the only page a browser is meant to load; every other action is meant to be hit, not
# rendered — by the page's own buttons, or by `curl` against the exact same path, which is
# why each one answers in plain text rather than a view. Nothing here excludes this
# controller's own traffic from the Sidecar: an exclusion option would be a product feature
# invented to tidy a test double, and the Initializer does not know a Scenario exists.
#
# Numbered 1–7, 9, 11 and 13. Scenario 8 (a rake-task burst) and Scenario 14 (a long-lived
# rake task) are `rake` tasks — see lib/tasks/scenarios.rake — and Scenario 10 (an
# Interrupted request, twice) and Scenario 12 (clustered Puma) are signal- and env-var-driven
# rather than a path of their own. None of those four gets a button — there is no path, or
# no server yet, to fire one at — but all four are still shown on the page as a
# copy-pasteable command, per #31, so the whole set lives in one place rather than sending a
# reader over to the README for a third of them. The README carries the same commands too,
# for the `curl`-only reading — an agent driving the app has no terminal of the page's own to
# read from.
class ScenariosController < ApplicationController
  # One row per button on the index page. `count` is how many times the page's own JS fires
  # `path` at once — 1 for everything but the two Scenarios that are about concurrency itself.
  Scenario = Data.define(:path, :label, :description, :count)

  # One row per non-HTTP Scenario: `command` is a shell snippet to copy, never wired to
  # anything on the page — this is the "no launcher" rule (#15) drawn precisely: showing a
  # command is documentation, firing one from a click would be a launcher.
  ScenarioCommand = Data.define(:label, :description, :command)

  RAKE_BURST_COMMAND = <<~SH
    bin/rake scenarios:rake_burst &
    for i in 1 2 3 4; do curl -s http://localhost:3000/scenarios/parallel & done; wait
  SH

  SIGKILL_COMMAND = <<~SH
    bin/dev & SERVER_PID=$!
    sleep 1
    curl -s http://localhost:3000/scenarios/hang &
    sleep 1
    kill -9 $SERVER_PID
    bin/dev & SERVER_PID=$!
    sleep 1
    kill -TERM $SERVER_PID
    wait $SERVER_PID
  SH

  TERM_FORCE_SHUTDOWN_COMMAND = <<~SH
    bin/dev & SERVER_PID=$!
    sleep 1
    curl -s http://localhost:3000/scenarios/hang &
    sleep 1
    kill -TERM $SERVER_PID
    wait $SERVER_PID
  SH

  CLUSTERED_COMMAND = <<~SH
    WEB_CONCURRENCY=2 bin/dev &
    sleep 2
    for i in $(seq 20); do curl -s http://localhost:3000/scenarios/flood & done; wait
  SH

  LONG_TASK_COMMAND = "bin/rake scenarios:long_task\n"

  def index
    @scenarios = [
      Scenario.new(path: scenario_parallel_path, count: 4, label: "1 — Parallel requests",
        description: "Four requests at once, each running a couple of queries, so their SQL interleaves."),
      Scenario.new(path: scenario_n_plus_one_path, count: 1, label: "2 — N+1",
        description: "One query for fifty comments, then one more per comment for its author."),
      Scenario.new(path: scenario_slow_query_path, count: 1, label: "3 — Slow query",
        description: "A recursive CTE, genuinely slow inside SQLite. No Ruby sleep involved."),
      Scenario.new(path: scenario_hang_path, count: 1, label: "4 — Hang",
        description: "Never finishes. Watch it climb in the Reader; reload this tab to give up on it."),
      Scenario.new(path: scenario_error_path, count: 1, label: "5 — 500 error",
        description: "An unhandled exception with a real backtrace."),
      Scenario.new(path: scenario_dual_homing_path, count: 1, label: "6 — Dual-homed log line",
        description: "A Rails.logger call sandwiched between two queries."),
      Scenario.new(path: scenario_raw_sql_path, count: 1, label: "7 — Raw SQL",
        description: "A bare connection.execute: no model, no binds, a nil name."),
      Scenario.new(path: scenario_flood_path, count: 20, label: "9 — Request flood",
        description: "The same cheap query, fired about twenty times at once."),
      Scenario.new(path: scenario_partial_request_path, count: 1, label: "11 — Partial request",
        description: "Two queries with a pause between them — see the README for how to " \
          "replace the Sidecar mid-flight and turn this into a genuine Partial request."),
      Scenario.new(path: scenario_trailing_event_path, count: 1, label: "13 — Trailing event",
        description: "A middleware outside Rails::Rack::Logger logs a line and runs a " \
          "query in its Rack::BodyProxy close block, after the request has already finished.")
    ]

    @scenario_commands = [
      ScenarioCommand.new(label: "8 — Rake-task burst",
        description: "Bulk unattributed queries from a second concurrent Run sharing the " \
          "Sidecar with the server — the only Scenario that tests ADR-0003's O_APPEND claim.",
        command: RAKE_BURST_COMMAND),
      ScenarioCommand.new(label: "10a — Interrupted via SIGKILL",
        description: "No at_exit runs, so no run_end is ever written for the killed Run — " \
          "the Reader has to conclude the interruption from the next Run's own run_header, " \
          "which is why this restarts the server once more.",
        command: SIGKILL_COMMAND),
      ScenarioCommand.new(label: "10b — Interrupted via TERM, the clean path",
        description: "config/puma.rb's force_shutdown_after 5 forces the hanging request's " \
          "thread rather than a plain TERM deadlocking forever; the process then exits " \
          "normally, so its at_exit still writes a real run_end.",
        command: TERM_FORCE_SHUTDOWN_COMMAND),
      ScenarioCommand.new(label: "12 — Clustered Puma",
        description: "WEB_CONCURRENCY=2 at launch, the only test of the pid-keyed run_id: " \
          "Puma preloads by default in cluster mode, so the boot run_header belongs to the " \
          "master, and each worker gets a run_id of its own the first time it handles anything.",
        command: CLUSTERED_COMMAND),
      ScenarioCommand.new(label: "14 — Long-lived rake task",
        description: "Outlives a server restart: start it, restart the server beside it " \
          "however you like, and it keeps its own run_id and its own climbing seq " \
          "throughout. Runs until you stop it.",
        command: LONG_TASK_COMMAND)
    ]
  end

  # Scenario 1 — parallel in-flight requests with interleaving queries. The parallelism is
  # the page's doing: its button fires several `fetch()` calls at this one path at once, and
  # Puma's thread pool runs them at once for real. This action just has to be worth the trip:
  # two ordinary queries, so each request's SQL has something to interleave with another
  # request's.
  def parallel
    posts = Post.published.includes(:author).limit(10).to_a
    comments = Comment.order(:created_at).limit(10).to_a

    render plain: "posts=#{posts.size} comments=#{comments.size}"
  end

  # Scenario 2 — an N+1-shaped request with ~50 near-identical children. One query for the
  # comments, then one more per comment for its author, because `.author` is never eager
  # loaded here on purpose.
  def n_plus_one
    comments = Comment.order(:id).limit(50).to_a
    authors = comments.map { |comment| comment.author.name }

    render plain: "comments=#{comments.size} authors=#{authors.size}"
  end

  # Scenario 3 — a slow query, honestly slow inside the database. A recursive CTE counting to
  # eight million spends real time inside SQLite doing real work; a Ruby `sleep` would only
  # prove the Reader can measure a `sleep`, which is a duration bug wearing a costume.
  SLOW_QUERY_SQL = <<~SQL
    WITH RECURSIVE counter(n) AS (
      SELECT 1
      UNION ALL
      SELECT n + 1 FROM counter WHERE n < 8000000
    )
    SELECT count(*) AS total FROM counter
  SQL

  def slow_query
    row = ActiveRecord::Base.connection.select_one(SLOW_QUERY_SQL)

    render plain: "total=#{row["total"]}"
  end

  # Scenario 4 — a hanging request. `sleep` with no argument sleeps until the thread is sent
  # a signal, which in practice is never: no timeout, no response, and no test in this suite
  # calls it — a test that did would hang too. Visible in the Reader as a climbing elapsed
  # pill for as long as the process runs.
  def hang
    sleep
  end

  # Scenario 5 — a 500 with a backtrace. Raised, not rescued: `process_action.action_controller`
  # hands the exception object to the Initializer, backtrace and all, before Rails' own
  # exception handling turns it into the response this action never gets to render.
  def error
    raise "Scenario 5: a deliberate, unhandled error."
  end

  # Scenario 6 — a `Rails.logger` call sandwiched between two queries: the dual-homing case.
  # The log line lands in the Console and, inline, in this request's own detail-column
  # timeline, interleaved with the query on either side of it.
  def dual_homing
    posts = Post.count
    Rails.logger.info("Scenario 6: #{posts} posts on file, checking comments next.")
    comments = Comment.count

    render plain: "posts=#{posts} comments=#{comments}"
  end

  # Scenario 7 — a raw `connection.execute`: no model, no binds, a `nil` name. `execute`'s
  # `name` argument defaults to `nil` and nothing here supplies one, which is the whole point:
  # the impoverished payload a Reader that assumed a model would break on.
  def raw_sql
    row = ActiveRecord::Base.connection.execute("SELECT count(*) AS total FROM posts").first
    total = row.is_a?(Hash) ? row["total"] : row[0]

    render plain: "total=#{total}"
  end

  # Scenario 9 — a request flood at ~20 concurrent. Deliberately the cheapest action here —
  # one query, nothing eager loaded — because this Scenario is about volume, not depth. Only
  # 8 of the 20 requests the page fires are ever truly mid-flight at once: `config/puma.rb`
  # fixes the pool at `threads 8, 8`, on purpose, for reasons that have nothing to do with
  # this Scenario, and it is not this ticket's place to widen it. Each request here is cheap
  # enough that the other 12 drain from the queue in milliseconds, so the Activity table
  # still sees the flood — as a burst rather than twenty requests genuinely overlapping.
  # `WEB_CONCURRENCY=2 bin/dev` (see the README) is how to watch a wider one.
  def flood
    render plain: "posts=#{Post.count}"
  end

  # Scenario 11 — a Partial request: attach the Reader mid-flight. The two queries either
  # side of the pause exist so something real can be done to the Sidecar between them — the
  # README's recipe replaces the file out from under this request while it sleeps, the same
  # as ADR-0003's boot-time truncation firing under a live Run. The first query, and the
  # request_start ahead of it, land before that swap and are gone once it happens; the
  # second query lands after, with a request_id the Reader can never trace back to a start —
  # a genuine Partial request rather than a race reproduced by hand.
  def partial_request
    Post.count
    sleep 2
    comments = Comment.count

    render plain: "comments=#{comments}"
  end

  # Scenario 13 — a middleware outside Rails::Rack::Logger, wrapping the response body in
  # its own Rack::BodyProxy, logging one line and running one query in the close block. This
  # action itself does nothing: everything that makes this Scenario what it is happens in
  # TrailingEventMiddleware, once the response below has already been sent.
  def trailing_event
    render plain: "ok"
  end
end
