require "test_helper"
require "support/development_run"

# The Reader's eval loop, run by a real `bin/rails console` the way the Reader runs it: frames
# on fd 3, and whatever the evaluated code prints on fds 1 and 2.
class EvalLoopTest < ActiveSupport::TestCase
  test "says it is ready, with the console process's pid and no capabilities yet" do
    DevelopmentRun.console_process do |repl|
      assert_equal "ready", repl.ready["type"]
      assert_operator repl.ready["pid"], :>, 0
      assert_equal [], repl.ready["capabilities"]
    end
  end

  test "answers an evaluation with its value's pretty_inspect, tied to its id" do
    DevelopmentRun.console_process do |repl|
      answer = repl.evaluate("1 + 1")

      assert_equal({ "type" => "result", "id" => 1, "text" => "2", "cut" => false }, answer)
    end
  end

  test "wraps a result at 80 columns and cuts it at 64 KB" do
    DevelopmentRun.console_process do |repl|
      wrapped = repl.evaluate("Array.new(30) { |i| i * 1000 }")
      long = repl.evaluate("'x' * 100_000")

      assert_operator wrapped["text"].lines.size, :>, 1
      assert wrapped["text"].lines.all? { |line| line.chomp.size <= 80 }, wrapped["text"]
      assert_equal true, long["cut"]
      assert_equal 64 * 1024, long["text"].bytesize
    end
  end

  test "keeps locals across evaluations, in one long-lived binding" do
    DevelopmentRun.console_process do |repl|
      repl.evaluate(%(post = Post.new(title: "Hello")))

      assert_equal %("Hello"), repl.evaluate("post.title")["text"]
    end
  end

  test "answers an evaluation that raises with its class and message" do
    DevelopmentRun.console_process do |repl|
      answer = repl.evaluate("raise ArgumentError, 'nope'")

      assert_equal({ "type" => "error", "id" => 1, "class" => "ArgumentError", "message" => "nope" }, answer)
      assert_equal "3", repl.evaluate("1 + 2")["text"], "the loop keeps going after a raise"
    end
  end

  test "reloads the app's code with reload!" do
    DevelopmentRun.console_process do |repl|
      answer = repl.evaluate("reload!")

      assert_equal "true", answer["text"]
      assert_includes repl.stdout_through("Reloading..."), "Reloading..."
    end
  end

  test "leaves what the code prints on fds 1 and 2, from Ruby and from a command it runs" do
    DevelopmentRun.console_process do |repl|
      repl.evaluate(%(puts "from puts"; system("echo from system"); warn "from warn"))

      assert_includes repl.stdout_through("from system"), "from puts"
      assert_includes repl.stderr_through("from warn"), "from warn"
    end
  end

  test "never echoes a query on stderr" do
    DevelopmentRun.console_process do |repl|
      repl.evaluate("Post.count")
      repl.evaluate(%(warn "after the query"))

      assert_no_match(/SELECT/, repl.stderr_through("after the query"))
    end
  end

  test "runs each evaluation the way a request runs, inside the executor, its result's inspect included" do
    DevelopmentRun.console_process do |repl|
      assert_equal "true", repl.evaluate("Rails.application.executor.active?")["text"]

      # A relation runs its query when it is inspected, so that has to happen inside too.
      inspected_inside = repl.evaluate("Class.new { def inspect = Rails.application.executor.active?.to_s }.new")
      assert_equal "true", inspected_inside["text"]
    end
  end

  test "answers an evaluation SIGINT stopped as raising Interrupt, and keeps going" do
    DevelopmentRun.console_process do |repl|
      interrupting = Thread.new do
        sleep 0.5
        repl.signal("INT")
      end
      answer = repl.evaluate("sleep 60")
      interrupting.join

      assert_equal({ "type" => "error", "id" => 1, "class" => "Interrupt", "message" => "" }, answer)
      assert_equal "2", repl.evaluate("1 + 1")["text"]
    end
  end

  test "does nothing on SIGINT between evaluations" do
    DevelopmentRun.console_process do |repl|
      repl.signal("INT")
      sleep 0.5

      assert_nil repl.exited_within(0), "SIGINT ended the console process"
      assert_equal "2", repl.evaluate("1 + 1")["text"]
    end
  end

  test "ends on SIGTERM during an evaluation, answering nothing, and its Run gets its run_end" do
    DevelopmentRun.console_process do |repl|
      repl.submit("sleep 60")
      sleep 0.5
      repl.signal("TERM")

      assert repl.exited_within(5), "the console process outlived SIGTERM"
      assert_equal [], repl.remaining_frames
      assert_equal "run_end", repl.sidecar_events.last["type"]
    end
  end

  test "ends when fd 3 closes during an evaluation, and its Run gets its run_end" do
    DevelopmentRun.console_process do |repl|
      repl.submit("sleep 60")
      sleep 0.5
      repl.close_frames

      assert repl.exited_within(2), "the console process outlived fd 3"
      assert_equal "run_end", repl.sidecar_events.last["type"]
    end
  end

  test "ends when fd 3 closes between evaluations" do
    DevelopmentRun.console_process do |repl|
      repl.close_frames

      assert repl.exited_within(2), "the console process outlived fd 3"
      assert_equal "run_end", repl.sidecar_events.last["type"]
    end
  end

  test "keeps a sandboxed console process's writes across evaluations, and rolls them back when it ends" do
    email = "sandbox-#{SecureRandom.hex(4)}@example.test"
    written = %(Author.where(email: #{email.inspect}).count)

    DevelopmentRun.console_process(sandbox: true) do |repl|
      repl.evaluate(%(Author.create!(name: "Sandboxed", email: #{email.inspect})))

      assert_equal "1", repl.evaluate(written)["text"]
    end
    DevelopmentRun.console_process do |repl|
      assert_equal "0", repl.evaluate(written)["text"]
    end
  end
end
