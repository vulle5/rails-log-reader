require "test_helper"
require "support/development_run"

# The Reader's eval loop, run by a real `bin/rails console` the way the Reader runs it: frames
# on fd 3, and whatever the evaluated code prints on fds 1 and 2.
class EvalLoopTest < ActiveSupport::TestCase
  test "says it is ready, with the console's pid and no capabilities yet" do
    DevelopmentRun.console do |console|
      assert_equal "ready", console.ready["type"]
      assert_operator console.ready["pid"], :>, 0
      assert_equal [], console.ready["capabilities"]
    end
  end

  test "answers an evaluation with its value's pretty_inspect, tied to its id" do
    DevelopmentRun.console do |console|
      answer = console.evaluate("1 + 1")

      assert_equal({ "type" => "result", "id" => 1, "text" => "2", "cut" => false }, answer)
    end
  end

  test "wraps a result at 80 columns and cuts it at 64 KB" do
    DevelopmentRun.console do |console|
      wrapped = console.evaluate("Array.new(30) { |i| i * 1000 }")
      long = console.evaluate("'x' * 100_000")

      assert_operator wrapped["text"].lines.size, :>, 1
      assert wrapped["text"].lines.all? { |line| line.chomp.size <= 80 }, wrapped["text"]
      assert_equal true, long["cut"]
      assert_equal 64 * 1024, long["text"].bytesize
    end
  end

  test "keeps locals across evaluations, in one long-lived binding" do
    DevelopmentRun.console do |console|
      console.evaluate(%(post = Post.new(title: "Hello")))

      assert_equal %("Hello"), console.evaluate("post.title")["text"]
    end
  end

  test "answers an evaluation that raises with its class and message" do
    DevelopmentRun.console do |console|
      answer = console.evaluate("raise ArgumentError, 'nope'")

      assert_equal({ "type" => "error", "id" => 1, "class" => "ArgumentError", "message" => "nope" }, answer)
      assert_equal "3", console.evaluate("1 + 2")["text"], "the loop keeps going after a raise"
    end
  end

  test "reloads the app's code with reload!" do
    DevelopmentRun.console do |console|
      answer = console.evaluate("reload!")

      assert_equal "true", answer["text"]
      assert_includes console.stdout_through("Reloading..."), "Reloading..."
    end
  end

  test "leaves what the code prints on fds 1 and 2, from Ruby and from a command it runs" do
    DevelopmentRun.console do |console|
      console.evaluate(%(puts "from puts"; system("echo from system"); warn "from warn"))

      assert_includes console.stdout_through("from system"), "from puts"
      assert_includes console.stderr_through("from warn"), "from warn"
    end
  end

  test "never echoes a query on stderr" do
    DevelopmentRun.console do |console|
      console.evaluate("Post.count")
      console.evaluate(%(warn "after the query"))

      assert_no_match(/SELECT/, console.stderr_through("after the query"))
    end
  end

  test "runs each evaluation the way a request runs, inside the executor" do
    DevelopmentRun.console do |console|
      assert_equal "true", console.evaluate("Rails.application.executor.active?")["text"]
    end
  end
end
