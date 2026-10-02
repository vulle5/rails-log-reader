require "test_helper"
require "support/development_run"

# An *Evaluation*: one input the REPL's eval loop ran, recorded as `evaluation_start` and
# `evaluation_finish` around it, with its queries and log lines carrying its id. Driven through a
# real `bin/rails console` running the loop, as the Reader starts it.
class EvaluationTest < ActiveSupport::TestCase
  # A pool that runs `load_async` queries on a background thread, which the Example app's own
  # configuration never builds. The pool is removed first, because establishing the same
  # configuration again hands back the pool already built.
  ASYNC_QUERIES = <<~RUBY
    ActiveRecord.async_query_executor = :global_thread_pool
    ActiveRecord::Base.remove_connection
    ActiveRecord::Base.establish_connection
  RUBY

  test "evaluating Post.count leaves its start and finish in the Sidecar, and its query carries the evaluation's id" do
    DevelopmentRun.console_process do |repl|
      assert_equal "result", repl.evaluate("Post.count")["type"]
      events = repl.sidecar_events

      start = events.select { |event| event["type"] == "evaluation_start" }.sole
      finish = events.select { |event| event["type"] == "evaluation_finish" }.sole
      count = events.find { |event| event["type"] == "sql" && event["payload"]["name"] == "Post Count" }

      assert_kind_of String, start["request_id"]
      assert_equal({ "input" => "Post.count", "sandbox" => false }, start["payload"])
      assert_equal start["request_id"], finish["request_id"]
      assert_equal %w[db_runtime_ms outcome], finish["payload"].keys.sort, "the result is never written to the Sidecar"
      assert_equal "ok", finish["payload"]["outcome"]
      assert_operator finish["payload"]["db_runtime_ms"], :>, 0

      assert count, "the query never reached the Sidecar"
      assert_equal start["request_id"], count["request_id"]
      assert_operator start["seq"], :<, count["seq"]
      assert_operator count["seq"], :<, finish["seq"]
    end
  end

  test "gives each evaluation an id of its own, and attributes its log lines to it" do
    DevelopmentRun.console_process do |repl|
      repl.evaluate(%(Rails.logger.info("first")))
      repl.evaluate(%(Rails.logger.info("second")))
      events = repl.sidecar_events

      starts = events.select { |event| event["type"] == "evaluation_start" }
      lines = %w[first second].map { |message| events.find { |event| event["type"] == "app_log" && event["payload"]["message"] == message } }

      assert_equal 2, starts.map { |start| start["request_id"] }.uniq.size
      assert_equal starts.map { |start| start["request_id"] }, lines.map { |line| line["request_id"] }
    end
  end

  test "says a sandboxed console's evaluation ran in the sandbox" do
    DevelopmentRun.console_process(sandbox: true) do |repl|
      repl.evaluate("1 + 1")

      start = repl.sidecar_events.select { |event| event["type"] == "evaluation_start" }.sole
      assert_equal true, start["payload"]["sandbox"]
    end
  end

  test "records a raising evaluation's finish as raised, with the exception's class and message" do
    DevelopmentRun.console_process do |repl|
      assert_equal "error", repl.evaluate(%(raise ArgumentError, "no such post"))["type"]

      finish = repl.sidecar_events.select { |event| event["type"] == "evaluation_finish" }.sole
      assert_equal "raised", finish["payload"]["outcome"]
      assert_equal "ArgumentError", finish["payload"]["class"]
      assert_equal "no such post", finish["payload"]["message"]
    end
  end

  test "records an evaluation Ctrl-C stopped as raising Interrupt" do
    DevelopmentRun.console_process do |repl|
      interrupting = Thread.new do
        sleep 0.5
        repl.signal("INT")
      end
      repl.evaluate("sleep 60")
      interrupting.join

      finish = repl.sidecar_events.select { |event| event["type"] == "evaluation_finish" }.sole
      assert_equal %w[raised Interrupt], finish["payload"].values_at("outcome", "class")
    end
  end

  test "cuts the input and the message at 64 KB, and says how long each was" do
    DevelopmentRun.console_process do |repl|
      input = %(raise "#{"m" * 70_000}")
      repl.evaluate(input)
      events = repl.sidecar_events

      start = events.select { |event| event["type"] == "evaluation_start" }.sole
      finish = events.select { |event| event["type"] == "evaluation_finish" }.sole
      assert_equal 64 * 1024, start["payload"]["input"].bytesize
      assert_equal({ "input" => input.bytesize }, start["truncated"])
      assert_equal 64 * 1024, finish["payload"]["message"].bytesize
      assert_equal({ "message" => 70_000 }, finish["truncated"])
    end
  end

  test "leaves what a thread the evaluation started emits unattributed" do
    DevelopmentRun.console_process do |repl|
      repl.evaluate(%(Thread.new { Author.count; Rails.logger.info("from the thread") }.join; Comment.count))
      events = repl.sidecar_events

      start = events.select { |event| event["type"] == "evaluation_start" }.sole
      threaded = events.select do |event|
        (event["type"] == "sql" && event["payload"]["name"] == "Author Count") ||
          (event["type"] == "app_log" && event["payload"]["message"] == "from the thread")
      end
      own = events.find { |event| event["type"] == "sql" && event["payload"]["name"] == "Comment Count" }

      assert_equal [nil, nil], threaded.map { |event| event["request_id"] }
      assert_equal start["request_id"], own["request_id"]
    end
  end

  test "attributes a load_async query to the evaluation that issued it" do
    DevelopmentRun.console_process(script: ASYNC_QUERIES) do |repl|
      # The pause lets the background thread run the query before the records are asked for,
      # which would otherwise run it here.
      repl.evaluate("posts = Post.where.not(id: nil).load_async; sleep 0.5; posts.to_a.size")
      events = repl.sidecar_events

      start = events.select { |event| event["type"] == "evaluation_start" }.sole
      async = events.select { |event| event["type"] == "sql" && event["payload"]["async"] }.sole
      assert_equal start["request_id"], async["request_id"]
    end
  end

  test "evaluates, emitting nothing, with the Initializer present but not enabled" do
    DevelopmentRun.console_process(marker: false) do |repl|
      assert_equal "2", repl.evaluate("1 + 1")["text"]
      assert_equal "error", repl.evaluate(%(raise "still answered"))["type"]

      assert_not File.exist?(File.join(repl.root, DevelopmentRun::SIDECAR)), "a Sidecar was written"
    end
  end

  test "evaluates, emitting nothing, with no Initializer at all" do
    DevelopmentRun.console_process(initializer: false) do |repl|
      assert_equal "2", repl.evaluate("1 + 1")["text"]
      assert_equal "error", repl.evaluate(%(raise "still answered"))["type"]

      assert_not File.exist?(File.join(repl.root, DevelopmentRun::SIDECAR)), "a Sidecar was written"
    end
  end
end
