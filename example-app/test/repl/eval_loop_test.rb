require "test_helper"
require "support/development_run"

# The Reader's eval loop, run by a real `bin/rails console` the way the Reader runs it: frames
# on fd 3, and whatever the evaluated code prints on fds 1 and 2.
class EvalLoopTest < ActiveSupport::TestCase
  test "says it is ready, with the console process's pid and the multi-line check among its capabilities" do
    DevelopmentRun.console_process do |repl|
      assert_equal "ready", repl.ready["type"]
      assert_operator repl.ready["pid"], :>, 0
      assert_equal ["check"], repl.ready["capabilities"]
    end
  end

  test "checks a complete input as complete, tied to its id" do
    DevelopmentRun.console_process do |repl|
      assert_equal({ "type" => "checked", "id" => 1, "complete" => true }, repl.check("1 + 1"))
      assert_equal true, repl.check("[1, 2].each do |x|\n  x\nend")["complete"]
      assert_equal true, repl.check("1 +)")["complete"], "a syntax error no line could fix runs, to show its error"
    end
  end

  test "checks an open block, a def with no end and an open string as incomplete" do
    DevelopmentRun.console_process do |repl|
      assert_equal false, repl.check("[1, 2].each do |x|")["complete"]
      assert_equal false, repl.check("def greet")["complete"]
      assert_equal false, repl.check(%("open))["complete"]
    end
  end

  test "checks with the locals evaluations have defined" do
    DevelopmentRun.console_process do |repl|
      # `a /b` is a division when `a` is a local, and an open regexp otherwise.
      assert_equal false, repl.check("a /b")["complete"]
      repl.evaluate("a = 4")

      assert_equal true, repl.check("a /b")["complete"]
    end
  end

  test "answers a check while an evaluation is running" do
    DevelopmentRun.console_process do |repl|
      running = repl.submit("sleep 1; 1")

      assert_equal "checked", repl.check("1 + 1")["type"]
      assert_equal running, repl.next_frame["id"]
    end
  end

  test "has no multi-line check without IRB's lexer, and checks every input as complete" do
    DevelopmentRun.console_process(script: "IRB.send(:remove_const, :RubyLex)") do |repl|
      assert_equal [], repl.ready["capabilities"]
      assert_equal true, repl.check("[1, 2].each do |x|")["complete"]
    end
  end

  test "answers an evaluation with its value's pretty_inspect and its tree, tied to its id" do
    DevelopmentRun.console_process do |repl|
      answer = repl.evaluate("1 + 1")

      assert_equal({ "type" => "result", "id" => 1, "text" => "2", "cut" => false, "tree" => { "type" => "integer", "inspect" => "2" } }, answer)
    end
  end

  test "lays a Hash out as pairs and an Array as items, each node with its inspect, its type and its path step" do
    DevelopmentRun.console_process do |repl|
      tree = repl.evaluate(%({a: 1, "b" => [1.0, nil, :c]}))["tree"]

      assert_equal "hash", tree["type"]
      assert_equal %({a: 1, "b" => [1.0, nil, :c]}), tree["inspect"]
      assert_nil tree["step"], "the whole value is reached by no step"
      (a_key, a_value), (b_key, b_value) = tree["pairs"]
      assert_equal({ "type" => "symbol", "inspect" => ":a" }, a_key)
      assert_equal({ "type" => "integer", "inspect" => "1", "step" => "[:a]" }, a_value)
      assert_equal({ "type" => "string", "inspect" => %("b") }, b_key)
      assert_equal "array", b_value["type"]
      assert_equal %([1.0, nil, :c]), b_value["inspect"]
      assert_equal %(["b"]), b_value["step"]
      assert_equal [
        { "type" => "float", "inspect" => "1.0", "step" => "[0]" },
        { "type" => "nil", "inspect" => "nil", "step" => "[1]" },
        { "type" => "symbol", "inspect" => ":c", "step" => "[2]" },
      ], b_value["items"]
    end
  end

  test "gives each leaf a Ruby type class, and a Time its own text" do
    DevelopmentRun.console_process do |repl|
      items = repl.evaluate(%([1, 1.0, BigDecimal("1.5"), 3r, "a", :a, nil, true, false, Time.utc(2026, 9, 29), Date.new(2026, 9, 29), Object]))["tree"]["items"]

      assert_equal %w[integer float decimal rational string symbol nil boolean boolean time time object], items.map { |item| item["type"] }
      assert_equal "2026-09-29 00:00:00 UTC", items[9]["inspect"]
    end
  end

  test "spends 1,000 nodes on a tree, breadth-first, saying how many items it left out" do
    DevelopmentRun.console_process do |repl|
      long = repl.evaluate("Array.new(5_000) { |i| i }")["tree"]
      nested = repl.evaluate("[Array.new(998, 0), [1, 2]]")["tree"]

      assert_equal 999, long["items"].size
      assert_equal 4_001, long["more"]
      first, second = nested["items"]
      assert_equal 997, first["items"].size
      assert_equal 1, first["more"]
      assert_equal [], second["items"], "breadth-first, the budget was spent on the first's items before the second's"
      assert_equal 2, second["more"]
    end
  end

  test "leaves out a container's more when it holds every item" do
    DevelopmentRun.console_process do |repl|
      assert_equal false, repl.evaluate("[1, 2]")["tree"].key?("more")
    end
  end

  test "cuts a node's inspect at 4 KB" do
    DevelopmentRun.console_process do |repl|
      leaf = repl.evaluate("['x' * 5_000]")["tree"]["items"][0]

      assert_equal 4 * 1024, leaf["inspect"].bytesize
      assert_equal true, leaf["cut"]
    end
  end

  test "answers a value whose inspect raises as a result, labelled with its class and noting what inspect raised" do
    DevelopmentRun.console_process do |repl|
      repl.evaluate(%(class Broken; def inspect = raise("nope"); end))
      answer = repl.evaluate("Broken.new")

      assert_equal "result", answer["type"]
      assert_equal "#<Broken>", answer["text"]
      assert_equal({ "type" => "object", "inspect" => "#<Broken>" }, answer["tree"])
      assert_equal "RuntimeError: nope", answer["inspect_error"]
    end
  end

  test "notes an inspect that raised inside a result, whatever it raised short of a signal" do
    DevelopmentRun.console_process do |repl|
      repl.evaluate(%(class Broken; def inspect = raise(NotImplementedError, "nope"); end))
      answer = repl.evaluate("[1, Broken.new]")

      assert_equal "result", answer["type"]
      assert_equal({ "type" => "object", "inspect" => "#<Broken>", "step" => "[1]" }, answer["tree"]["items"][1])
      assert_equal "NotImplementedError: nope", answer["inspect_error"]
    end
  end

  test "lays a Set out as items reached by no step" do
    DevelopmentRun.console_process do |repl|
      tree = repl.evaluate("Set[1, :a]")["tree"]

      assert_equal "set", tree["type"]
      assert_equal "Set", tree["class"]
      assert_equal [{ "type" => "integer", "inspect" => "1" }, { "type" => "symbol", "inspect" => ":a" }], tree["items"]
    end
  end

  test "lays a Struct out as its members, each reached by its [] step" do
    DevelopmentRun.console_process do |repl|
      repl.evaluate("Point = Struct.new(:x, :y)")
      tree = repl.evaluate("Point.new(1, [2])")["tree"]

      assert_equal "struct", tree["type"]
      assert_equal "Point", tree["class"]
      assert_equal "#<struct Point x=1, y=[2]>", tree["inspect"]
      (x_name, x), (y_name, y) = tree["fields"]
      assert_equal ["x", { "type" => "integer", "inspect" => "1", "step" => "[:x]" }], [x_name, x]
      assert_equal "y", y_name
      assert_equal "array", y["type"]
      assert_equal "[:y]", y["step"]
    end
  end

  test "lays a Data out as its members, reached by no step, where Ruby has Data" do
    DevelopmentRun.console_process do |repl|
      skip "this Ruby has no Data" unless repl.evaluate("defined?(Data.define) ? 1 : 0")["text"] == "1"

      repl.evaluate("Coord = Data.define(:lat, :lng)")
      tree = repl.evaluate("Coord.new(lat: 1, lng: 2)")["tree"]

      assert_equal "data", tree["type"]
      assert_equal "Coord", tree["class"]
      assert_equal [["lat", { "type" => "integer", "inspect" => "1" }], ["lng", { "type" => "integer", "inspect" => "2" }]], tree["fields"]
    end
  end

  test "lays a record out as its attributes, each reached by its [] step, labelled with its class" do
    DevelopmentRun.console_process do |repl|
      tree = repl.evaluate(%(Comment.new(body: "Hi")))["tree"]

      assert_equal "record", tree["type"]
      assert_equal "Comment", tree["class"]
      assert_equal %w[id author_id body created_at post_id updated_at].sort, tree["fields"].map(&:first).sort
      _, body = tree["fields"].assoc("body")
      assert_equal({ "type" => "string", "inspect" => %("Hi"), "step" => "[:body]" }, body)
    end
  end

  test "marks a record's filtered attribute as filtered, as the app's filter_attributes say" do
    DevelopmentRun.console_process do |repl|
      tree = repl.evaluate(%(Author.new(name: "Ada", email: "ada@example.test")))["tree"]

      _, email = tree["fields"].assoc("email")
      assert_equal({ "type" => "filtered", "inspect" => "[FILTERED]", "step" => "[:email]" }, email)
      _, name = tree["fields"].assoc("name")
      assert_equal %("Ada"), name["inspect"]
    end
  end

  test "lays a Relation out as its first ten records, with more when there are more" do
    DevelopmentRun.console_process do |repl|
      tree = repl.evaluate("Post.all")["tree"]
      few = repl.evaluate("Post.limit(2)")["tree"]

      assert_equal "relation", tree["type"]
      assert_equal "ActiveRecord::Relation", tree["class"]
      assert_equal 10, tree["items"].size
      assert_equal %w[record], tree["items"].map { |item| item["type"] }.uniq
      assert_equal "[9]", tree["items"].last["step"]
      assert tree.key?("more"), "a Relation of more than ten records says it has more"
      assert_nil tree["more"], "without counting how many"
      assert_equal 2, few["items"].size
      assert_equal false, few.key?("more")
    end
  end

  test "shows a Relation, as a tree and as text, with one query" do
    DevelopmentRun.console_process do |repl|
      repl.evaluate(<<~RUBY)
        $queries = []
        ActiveSupport::Notifications.subscribe("sql.active_record") { |*, payload| $queries << payload[:sql] if payload[:sql].include?('FROM "posts"') }
      RUBY
      answer = repl.evaluate("$queries.clear; Post.all")
      queries = repl.evaluate("$queries.dup")["tree"]["items"].map { |query| query["inspect"] }

      assert_equal 1, queries.size, queries.inspect
      assert_match(/LIMIT/, queries.first)
      assert_match(/\A\[#<Post:.*"\.\.\."\]\z/m, answer["text"])
      assert_match(/\A#<ActiveRecord::Relation \[#<Post id: /, answer["tree"]["inspect"])
    end
  end

  test "shows a Relation inside another value with one query" do
    DevelopmentRun.console_process do |repl|
      repl.evaluate(<<~RUBY)
        $queries = []
        ActiveSupport::Notifications.subscribe("sql.active_record") { |*, payload| $queries << payload[:sql] if payload[:sql].include?('FROM "posts"') }
      RUBY
      answer = repl.evaluate("$queries.clear; {posts: Post.all}")
      count = repl.evaluate("$queries.size")["text"]

      assert_equal "1", count
      assert_equal "relation", answer["tree"]["pairs"][0][1]["type"]
    end
  end

  test "lays an object with Ruby's own inspect out as its ivars, reached by no step" do
    DevelopmentRun.console_process do |repl|
      repl.evaluate(%(class Money; def initialize(cents, currency) = (@cents, @currency = cents, currency); end))
      tree = repl.evaluate(%(Money.new(100, "EUR")))["tree"]

      assert_equal "object", tree["type"]
      assert_equal "Money", tree["class"]
      assert_equal [["@cents", { "type" => "integer", "inspect" => "100" }], ["@currency", { "type" => "string", "inspect" => %("EUR") }]], tree["fields"]
    end
  end

  test "leaves an object with its own inspect as a leaf of that text" do
    DevelopmentRun.console_process do |repl|
      repl.evaluate(%(class Tagged; def initialize = @tag = 1; def inspect = "tagged"; end))
      tree = repl.evaluate("Tagged.new")["tree"]

      assert_equal({ "type" => "object", "inspect" => "tagged" }, tree)
    end
  end

  test "marks a value that contains itself as a cycle, and repeats a shared one that does not" do
    DevelopmentRun.console_process do |repl|
      cyclic = repl.evaluate("h = {a: 1}; h[:self] = h; h")["tree"]
      shared = repl.evaluate("s = [1]; [s, s]")["tree"]

      assert_equal({ "type" => "cycle", "inspect" => "{...}", "step" => "[:self]" }, cyclic["pairs"][1][1])
      assert_equal [[{ "type" => "integer", "inspect" => "1", "step" => "[0]" }]] * 2, shared["items"].map { |item| item["items"] }
    end
  end

  test "marks an object that reaches itself through an ivar as a cycle" do
    DevelopmentRun.console_process do |repl|
      repl.evaluate(%(class Node; def initialize = @parent = self; end))
      tree = repl.evaluate("Node.new")["tree"]

      assert_equal [["@parent", { "type" => "cycle", "inspect" => "#<Node ...>" }]], tree["fields"]
    end
  end

  test "answers a BasicObject as a result, labelled with its class" do
    DevelopmentRun.console_process do |repl|
      answer = repl.evaluate("[BasicObject.new]")

      assert_equal "result", answer["type"]
      assert_equal({ "type" => "object", "inspect" => "#<BasicObject>", "step" => "[0]" }, answer["tree"]["items"][0])
    end
  end

  test "answers a Relation whose query raises as a result, not laid out, noting what its inspect raised, with one query" do
    DevelopmentRun.console_process do |repl|
      repl.evaluate(<<~RUBY)
        $queries = []
        ActiveSupport::Notifications.subscribe("sql.active_record") { |*, payload| $queries << payload[:sql] if payload[:sql].include?('FROM "posts"') }
      RUBY
      answer = repl.evaluate(%($queries.clear; Post.where("nope =")))
      count = repl.evaluate("$queries.size")["text"]

      assert_equal "result", answer["type"]
      assert_equal({ "type" => "relation", "inspect" => "#<ActiveRecord::Relation>" }, answer["tree"])
      assert_match(/\AActiveRecord::StatementInvalid: /, answer["inspect_error"])
      assert_equal "1", count
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
