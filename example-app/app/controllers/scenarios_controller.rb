# The traffic shapes the Reader exists to make readable, one action per Scenario. `index`
# is the only page a browser is meant to load; every other action is meant to be hit, not
# rendered — by the page's own buttons, or by `curl` against the exact same path, which is
# why each one answers in plain text rather than a view. Nothing here excludes this
# controller's own traffic from the Sidecar: an exclusion option would be a product feature
# invented to tidy a test double, and the Initializer does not know a Scenario exists.
class ScenariosController < ApplicationController
  def index
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
  # one query, nothing eager loaded — because this Scenario is about volume, not depth: the
  # page's button fires it around twenty times at once.
  def flood
    render plain: "posts=#{Post.count}"
  end
end
