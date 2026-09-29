# frozen_string_literal: true

# rails-log-reader's REPL — the eval loop the Reader runs Ruby in the Host app with.
#
# The Reader starts it as `bin/rails console -- -f -r <this file>`, from the Rails root, with a
# socket as file descriptor 3. IRB loads it while it sets up and it never returns, so IRB never
# prompts. It runs under the Host app's Ruby, so it keeps to what Ruby 2.7 has.
#
# Frames travel on fd 3 as one JSON object per line, each tied to the id the Reader gave it:
#
#   in:  {"type":"eval","id":1,"input":"1 + 1"}
#        {"type":"check","id":2,"text":"[1, 2].each do |x|"}
#   out: {"type":"ready","pid":48213,"capabilities":["check"]}
#        {"type":"result","id":1,"text":"2","cut":false,"tree":{"type":"integer","inspect":"2"}}
#        {"type":"error","id":1,"class":"NameError","message":"undefined local variable ..."}
#        {"type":"checked","id":2,"complete":false}
#
# A result's `tree` is its value laid out, and `inspect_error` says what an `inspect` raised while
# it was built, when one did. A node carries its own `inspect` text, `cut` when that was cut, and
# its type class: `hash` and `array`, which are laid out, or a leaf's, such as `symbol`, `float`
# or `time`. Under the whole value, each node carries the `[…]` step that reaches it from its
# container. A Hash's `pairs` are `[key, value]`, the key a leaf that is never laid out. An
# Array's are `items`. A container cut short carries how many it left out as `more`:
#
#   {"type":"hash","inspect":"{a: [1, 2]}","pairs":[
#     [{"type":"symbol","inspect":":a"},
#      {"type":"array","inspect":"[1, 2]","step":"[:a]","items":[{"type":"integer","inspect":"1","step":"[0]"}],"more":1}]]}
#
# `check` asks whether a text is a whole input or needs more lines, and is answered even while
# an evaluation runs. It uses IRB's lexer, and `ready` lists "check" among its capabilities
# only when that lexer is one the loop knows how to call. Without it, every text is complete.
#
# Fds 1 and 2 are the console process's own, read by the Reader as plain text, so nothing the
# Host app prints can corrupt a frame. The process ends when fd 3 closes, even mid-evaluation.

require "json"
require "pp"

module RailsLogReaderRepl
  # A result's text is cut at this many bytes.
  RESULT_LIMIT = 64 * 1024

  # The most nodes a result's tree holds, spent breadth-first.
  NODE_LIMIT = 1_000

  # A node's `inspect` text, and what an `inspect` raised, is cut at this many bytes.
  INSPECT_LIMIT = 4 * 1024

  # What an `inspect` can raise and still leave a result.
  INSPECT_FAILURES = [StandardError, ScriptError, SystemStackError].freeze

  # The width `pretty_inspect` wraps a result at.
  WIDTH = 80

  # A buffer for `PP` that stops it once it holds more than `limit` bytes.
  class Bounded
    attr_reader :text

    def initialize(limit)
      @limit = limit
      @text = +""
    end

    def <<(chunk)
      @text << chunk
      throw self if @text.bytesize > @limit
      self
    end
  end

  class << self
    def run
      # Two IOs on the one socket: a single read-write IO drops what it has read ahead
      # whenever it writes.
      input = IO.new(3, "r", autoclose: false)
      @frames = IO.new(3, "w", autoclose: false)
      @frames.sync = true
      # Both threads send frames.
      @sending = Mutex.new
      # A command the Host app's code runs does not inherit fd 3.
      input.close_on_exec = true
      # Flushed as well: while anything the boot printed is still buffered, a synced IO keeps
      # buffering behind it.
      [$stdout, $stderr].each do |io|
        io.sync = true
        io.flush
      end

      quiet_query_echo
      define_reload
      trap_interrupt
      @binding = TOPLEVEL_BINDING.eval("binding")

      @lexer = lexer
      inbox = read_frames(input)
      send_frame("type" => "ready", "pid" => Process.pid, "capabilities" => @lexer ? ["check"] : [])

      while (frame = inbox.pop)
        evaluate(frame["id"], frame["input"]) if frame["type"] == "eval"
      end
    end

    private

    # A queue of the frames fd 3 receives, read on a thread of its own so that fd 3 closing is
    # heard while an evaluation runs. It ends the main thread then, wherever it is, the way
    # `exit` would, so `at_exit` hooks still run. The queue itself never ends, so that raise is
    # the only way out of the loop. A check is answered on this thread and never queued.
    def read_frames(input)
      inbox = Queue.new
      Thread.new do
        while (line = input.gets)
          frame = JSON.parse(line)
          if frame["type"] == "check"
            send_frame("type" => "checked", "id" => frame["id"], "complete" => complete?(frame["text"]))
          else
            inbox << frame
          end
        end
      ensure
        Thread.main.raise(SystemExit)
      end
      inbox
    end

    # IRB's lexer, when it is the one whose `check_code_state` takes the locals by keyword.
    def lexer
      return unless defined?(IRB::RubyLex)
      return unless IRB::RubyLex.instance_method(:initialize).arity.zero?
      return unless IRB::RubyLex.instance_method(:check_code_state).parameters.include?([:keyreq, :local_variables])

      IRB::RubyLex.new
    end

    # Whether `text` is a whole input: nothing left open, and no syntax error another line could
    # fix. A text the lexer cannot read is complete, so running it shows what is wrong.
    def complete?(text)
      return true unless @lexer

      _, _, terminated = @lexer.check_code_state(text.to_s, local_variables: @binding.local_variables)
      terminated
    rescue StandardError
      true
    end

    # Detaches the stderr logger Active Record's `console` hook adds, so no query is echoed on
    # fd 2. Each query still reaches the Sidecar.
    def quiet_query_echo
      logger = Rails.logger
      return unless logger.respond_to?(:broadcasts)

      logger.broadcasts.select { |each| ActiveSupport::Logger.logger_outputs_to?(each, STDERR) }.each do |each|
        logger.stop_broadcasting_to(each)
      end
    end

    # What `bin/rails console` offers as an IRB command, which the loop never reaches.
    def define_reload
      TOPLEVEL_BINDING.receiver.define_singleton_method(:reload!) do |print = true|
        puts "Reloading..." if print
        Rails.application.reloader.reload!
        true
      end
    end

    # SIGINT raises `Interrupt` inside the running evaluation, as Ctrl-C does in a terminal, and
    # does nothing between evaluations.
    def trap_interrupt
      trap("INT") { raise Interrupt, "" if @evaluating }
    end

    # Runs `source` the way a request runs, so the query cache is fresh and a reload is safe. The
    # result is inspected and laid out inside too, since inspecting a relation runs its query.
    #
    # `exit` and a signal such as SIGTERM end the process rather than the evaluation, except
    # Ctrl-C's `Interrupt`, which is the evaluation's answer.
    def evaluate(id, source)
      frame = interruptible { Rails.application.executor.wrap { result(@binding.eval(source, "(repl)", 1)) } }
      send_frame({ "type" => "result", "id" => id }.merge(frame))
    rescue SystemExit
      raise
    rescue Exception => error
      raise if error.is_a?(SignalException) && !error.is_a?(Interrupt)

      send_frame("type" => "error", "id" => id, "class" => class_name(error), "message" => utf8(error.message))
    end

    def interruptible
      @evaluating = true
      yield
    ensure
      @evaluating = false
    end

    # A result frame's fields for `value`. An `inspect` that raises, the value's own or one
    # inside it, leaves its node's label in place of its text, and the first one is noted.
    def result(value)
      @inspect_error = nil
      tree = tree(value)
      text, cut = pretty(value) { tree["inspect"] }
      frame = { "text" => text, "cut" => cut, "tree" => tree }
      frame["inspect_error"] = @inspect_error if @inspect_error
      frame
    end

    # `value`'s `pretty_inspect`, or what `fallback` gives when it raises.
    def pretty(value)
      buffer = Bounded.new(RESULT_LIMIT)
      cut = true
      catch(buffer) do
        PP.pp(value, buffer, WIDTH)
        cut = false
      end
      text = cut ? buffer.text.byteslice(0, RESULT_LIMIT) : buffer.text.chomp
      [utf8(text), cut]
    rescue *INSPECT_FAILURES => error
      noted(error)
      [yield, false]
    end

    # `value` laid out breadth-first, until `NODE_LIMIT` nodes have been spent. A key is part of
    # its pair's node, not one of its own.
    def tree(value)
      root = node(value)
      budget = NODE_LIMIT - 1
      queue = []
      queue << [value, root] if laid_out?(root)
      until queue.empty?
        container, parent = queue.shift
        children = parent[parent["type"] == "hash" ? "pairs" : "items"] = []
        each_entry(container) do |item, step, key|
          break if budget.zero?

          budget -= 1
          child = node(item).merge("step" => step)
          children << (key ? [key, child] : child)
          queue << [item, child] if laid_out?(child)
        end
        parent["more"] = container.size - children.size if children.size < container.size
      end
      root
    end

    # Yields each item of a Hash or an Array with the `[…]` step that reaches it, and a Hash
    # item's key node. A key cut at `INSPECT_LIMIT` gives a step cut with it.
    def each_entry(container)
      if container.is_a?(Hash)
        container.each_pair do |key, item|
          key_node = node(key)
          yield item, "[#{key_node['inspect']}]", key_node
        end
      else
        container.each_with_index { |item, index| yield item, "[#{index}]", nil }
      end
    end

    def laid_out?(node)
      node["type"] == "hash" || node["type"] == "array"
    end

    def node(value)
      text, cut = inspect_text(value)
      node = { "type" => type_class(value), "inspect" => text }
      node["cut"] = true if cut
      node
    end

    # What kind of value `value` is, told by `===` alone, which a BasicObject answers too.
    def type_class(value)
      case value
      when nil then "nil"
      when true, false then "boolean"
      when String then "string"
      when Symbol then "symbol"
      when Integer then "integer"
      when Float then "float"
      when Rational then "rational"
      when Complex then "complex"
      when Hash then "hash"
      when Array then "array"
      when Time then "time"
      else
        if defined?(::Date) && ::Date === value then "time"
        elsif defined?(::BigDecimal) && ::BigDecimal === value then "decimal"
        else "object"
        end
      end
    end

    # `value`'s `inspect` cut to `INSPECT_LIMIT`, and whether it was cut. One that raises gives
    # the value's label.
    def inspect_text(value)
      text = value.inspect.to_s
      return [utf8(text), false] if text.bytesize <= INSPECT_LIMIT

      [utf8(text.byteslice(0, INSPECT_LIMIT)), true]
    rescue *INSPECT_FAILURES => error
      noted(error)
      [label(value), false]
    end

    # `#<Post>`: the value's class, which a BasicObject, with no `class` of its own, answers too.
    def label(value)
      klass =
        begin
          Kernel.instance_method(:class).bind(value).call
        rescue TypeError
          (class << value; self; end).superclass
        end
      "#<#{klass.name || klass.inspect}>"
    end

    def noted(error)
      @inspect_error ||= utf8("#{class_name(error)}: #{error.message}".byteslice(0, INSPECT_LIMIT))
    end

    def class_name(error)
      error.class.name || error.class.inspect
    end

    # JSON carries UTF-8 alone. A string that is not, or is cut inside a character, keeps what
    # it can.
    def utf8(text)
      text.dup.force_encoding(Encoding::UTF_8).scrub
    end

    def send_frame(frame)
      line = "#{JSON.generate(frame)}\n"
      @sending.synchronize { @frames.write(line) }
    end
  end
end

RailsLogReaderRepl.run
exit
