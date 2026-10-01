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
#        {"type":"complete","id":3,"text":"\"abc\".up","caret":8}
#   out: {"type":"ready","pid":48213,"capabilities":["check","complete"],"completor":"TypeCompletor"}
#        {"type":"result","id":1,"class":"Integer","text":"2","cut":false,"tree":{"type":"integer","inspect":"2"}}
#        {"type":"error","id":1,"class":"NameError","message":"undefined local variable ...",
#         "backtrace":["(repl):1:in `<main>'"],"causes":[]}
#        {"type":"checked","id":2,"complete":false}
#        {"type":"completions","id":3,"from":6,"receiver":"String",
#         "candidates":[{"text":"upcase","kind":"method"},{"text":"upcase!","kind":"method"}]}
#
# A result's `class` names its value's class, its `tree` is its value laid out, and
# `inspect_error` says what an `inspect` raised while it was built, when one did. A node carries
# its own `inspect` text, `cut` when that was cut, and its type class: one that is laid out, or a leaf's, such as `symbol`, `float` or `time`. Under
# the whole value, each node carries the `[…]` step that reaches it from its container, when one
# does: a Set's member, a Data's member and an ivar have none. A Hash's entries are `pairs` of
# `[key, value]`, the key a leaf that is never laid out. An Array's, a Set's and a Relation's are
# `items`, a Relation's being the ten records its `inspect` shows. A record's attributes, a
# Struct's or a Data's members and an `object`'s ivars are `fields` of `[name, value]`. An
# `object` is laid out only when Ruby's own `inspect` writes it, and is a leaf of its own
# `inspect` otherwise. Each of these but a Hash and an Array carries its class's `class` name. A
# record's filtered attribute is a `filtered` leaf, and a value met again inside itself a
# `cycle` leaf. A container cut short carries how many it left out as `more`, which is null for a
# Relation with more records than it shows:
#
#   {"type":"hash","inspect":"{a: [1, 2]}","pairs":[
#     [{"type":"symbol","inspect":":a"},
#      {"type":"array","inspect":"[1, 2]","step":"[:a]","items":[{"type":"integer","inspect":"1","step":"[0]"}],"more":1}]]}
#
# An `error`'s `backtrace` runs from where it was raised down to the developer's last `(repl):N`
# frame, so none of the loop's own frames bury theirs, and is empty when the error came before any
# of their code ran, such as a SyntaxError. Its `causes` are the errors that led to it, nearest
# first, each with its own `class`, `message` and `backtrace`, and empty when it had none. A
# backtrace is kept whole up to 64 KB, then its far end is cut and the error says so with `cut`,
# and only the nearest ten causes are sent, the error saying so with `causes_cut`. Neither key is
# there when nothing was cut.
#
# `check` asks whether a text is a whole input or needs more lines, and is answered even while
# an evaluation runs. It uses IRB's lexer, and `ready` lists "check" among its capabilities
# only when that lexer is one the loop knows how to call. Without it, every text is complete.
#
# `complete` asks what the word ending at `caret` could be, and is answered with `completions`.
# The caret and `from` are counted in UTF-16 code units, as the browser counts them. `from` is where
# that word starts in the text, and each candidate's `text`
# replaces the text from `from` to the caret. A candidate's `kind` is `method`, `constant`, `local`,
# `ivar`, `cvar`, `gvar`, `keyword`, `symbol` or `path`, and `receiver` names what it was asked of
# when it was a member: a literal's or a variable's class, and otherwise the receiver as it was
# typed. Candidates are sorted, each once, and cut at 500. When there are none, `reason` says why
# in their place. It is queued behind an evaluation and never run beside one.
#
# It uses IRB's completors: `TypeCompletor` when `repl_type_completor` is in the bundle and IRB is
# not set to `:regexp`, and `RegexpCompletor` otherwise. `ready` lists "complete" among its
# capabilities and names the `completor` only when the one it has is one the loop knows how to
# call, and without either, completion is answered with a `reason` alone. `RegexpCompletor` reads
# a member's receiver off its text, and the loop leaves a text alone that would make it call a
# method to find out.
#
# Fds 1 and 2 are the console process's own, read by the Reader as plain text, so nothing the
# Host app prints can corrupt a frame. The process ends when fd 3 closes, even mid-evaluation.
#
# When the Host app's Initializer defines `RailsLogReader.evaluation`, each evaluation runs inside
# it, which records the evaluation in the Sidecar and attributes its queries and log lines to it.
# Its id there is `repl-<token>-<id>`, where the token is this process's own, so no two consoles'
# evaluations share one. Without the Initializer, an evaluation runs just the same.

require "json"
require "pp"
require "securerandom"

module RailsLogReaderRepl
  # A result's text is cut at this many bytes.
  RESULT_LIMIT = 64 * 1024

  # The most nodes a result's tree holds, spent breadth-first.
  NODE_LIMIT = 1_000

  # A node's `inspect` text, and what an `inspect` raised, is cut at this many bytes.
  INSPECT_LIMIT = 4 * 1024

  # What an `inspect` can raise and still leave a result.
  INSPECT_FAILURES = [StandardError, ScriptError, SystemStackError].freeze

  # The file name every frame of the developer's own input carries in a backtrace, and this
  # file's own path, which every frame of the loop does.
  EVAL_FILE = "(repl)"
  LOOP_FILE = __FILE__

  # An error's backtrace is cut at this many bytes of frames, and only this many of its causes
  # are sent.
  BACKTRACE_LIMIT = 64 * 1024
  CAUSE_LIMIT = 10

  # The most candidates a completion answers with.
  COMPLETION_LIMIT = 500

  # The characters IRB ends the word it completes at, so what precedes the last one is left out
  # of the word, as IRB leaves it out.
  WORD_BREAK = /[ \t\n`><=;|&{(]/

  # What a completor is called with, as IRB's own are: three texts and the binding. Anything else
  # is a completor the loop does not know how to call.
  COMPLETION_PARAMETERS = %i[req req req keyreq].freeze

  # A completion's `receiver` for what Prism reads a literal as.
  LITERALS = {
    "StringNode" => "String", "InterpolatedStringNode" => "String", "XStringNode" => "String",
    "SymbolNode" => "Symbol", "InterpolatedSymbolNode" => "Symbol",
    "ArrayNode" => "Array", "HashNode" => "Hash", "RangeNode" => "Range", "LambdaNode" => "Proc",
    "RegularExpressionNode" => "Regexp", "InterpolatedRegularExpressionNode" => "Regexp",
    "IntegerNode" => "Integer", "FloatNode" => "Float", "RationalNode" => "Rational",
    "ImaginaryNode" => "Complex", "NilNode" => "NilClass", "TrueNode" => "TrueClass",
    "FalseNode" => "FalseClass"
  }.freeze

  # Ruby's reserved words, which a completor offers beside the names in scope.
  KEYWORDS = %w[
    __ENCODING__ __LINE__ __FILE__ BEGIN END alias and begin break case class def defined? do else
    elsif end ensure false for if in module next nil not or redo rescue retry return self super
    then true undef unless until when while yield
  ].freeze

  # What a completor's `TypeCompletor` asks its context for.
  CompletionContext = Struct.new(:irb_path)

  # The width `pretty_inspect` wraps a result at.
  WIDTH = 80

  # The most records of a Relation laid out. It loads one more, to tell whether it has more.
  RELATION_LIMIT = 10

  # Where each type class that is laid out keeps its entries.
  ENTRIES = {
    "hash" => "pairs", "array" => "items", "set" => "items", "relation" => "items",
    "struct" => "fields", "data" => "fields", "record" => "fields", "object" => "fields"
  }.freeze

  # A record's filtered attribute, laid out in place of its value.
  FILTERED = Object.new.freeze

  # `Data`, on a Ruby that has it.
  DATA = (::Data if defined?(::Data) && ::Data.respond_to?(:define))

  # Kernel's own, bound to a value, so a value whose class redefines them is still read.
  METHOD = Kernel.instance_method(:method)
  IVARS = Kernel.instance_method(:instance_variables)
  IVAR = Kernel.instance_method(:instance_variable_get)
  RESPONDS = Kernel.instance_method(:respond_to?)

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

  # Prepended to a Relation, which loads its records afresh each time it is inspected or
  # pretty-printed. While a result is built, one that is not loaded stands in a loaded copy
  # instead, which loads what `inspect` shows once for the node, its records and the text,
  # wherever the Relation sits in the result.
  module LoadedOnce
    def inspect
      shown = RailsLogReaderRepl.shown(self)
      shown ? shown.inspect : super
    end

    def pretty_print(printer)
      shown = RailsLogReaderRepl.shown(self)
      shown ? shown.pretty_print(printer) : super
    end
  end

  class << self
    # The loaded copy that stands in for `relation` while a result is built, or nil when none
    # is being built or `relation` is loaded itself. A load that raised raises again, without
    # trying the query again.
    def shown(relation)
      return if @shown.nil? || relation.loaded?

      shown = @shown[relation] ||=
        begin
          relation.annotate("loading for inspect").limit(inspect_limit(relation)).load
        rescue *INSPECT_FAILURES => error
          error
        end
      raise shown if shown.is_a?(Exception)

      shown
    end

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
      ::ActiveRecord::Relation.prepend(LoadedOnce) if defined?(::ActiveRecord::Relation)
      define_reload
      trap_interrupt
      @binding = TOPLEVEL_BINDING.eval("binding")
      @token = SecureRandom.hex(4)

      @lexer = lexer
      @completor, completor_name = completor
      inbox = read_frames(input)
      capabilities = [("check" if @lexer), ("complete" if @completor)].compact
      send_frame("type" => "ready", "pid" => Process.pid, "capabilities" => capabilities, "completor" => completor_name)

      while (frame = inbox.pop)
        case frame["type"]
        when "eval" then evaluate(frame["id"], frame["input"])
        when "complete" then complete(frame["id"], frame["text"], frame["caret"])
        end
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

    # The completor IRB would complete with, and its name, when it is one the loop can call.
    def completor
      wanted = IRB.conf[:COMPLETOR] if defined?(IRB.conf)
      if wanted != :regexp && callable?("TypeCompletor") && type_completor_loads?
        [IRB::TypeCompletor.new(CompletionContext.new(EVAL_FILE)), "TypeCompletor"]
      elsif callable?("RegexpCompletor")
        [IRB::RegexpCompletor.new, "RegexpCompletor"]
      end
    end

    def callable?(name)
      return false unless defined?(IRB) && IRB.const_defined?(name, false)

      parameters = IRB.const_get(name, false).instance_method(:completion_candidates).parameters
      parameters.map(&:first) == COMPLETION_PARAMETERS && parameters.last.last == :bind
    rescue NameError
      false
    end

    # Loads `repl_type_completor`, as IRB does, and has it read its signatures in the background.
    def type_completor_loads?
      return false if RUBY_ENGINE == "truffleruby"

      require "repl_type_completor"
      ReplTypeCompletor.preload_rbs
      true
    rescue LoadError
      false
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

    # Answers what the word before `caret` in `text` could be, in the executor an evaluation runs
    # in, since a completor reads constants that may autoload.
    def complete(id, text, caret)
      answer = Rails.application.executor.wrap { completion(text.to_s, caret) }
      send_frame({ "type" => "completions", "id" => id }.merge(answer))
    end

    # A completion's fields: its candidates, or the `reason` it has none.
    def completion(text, caret)
      return { "reason" => "Completion isn't available." } unless @completor

      units = text.encode(Encoding::UTF_16LE)
      caret = caret.is_a?(Integer) ? caret.clamp(0, units.bytesize / 2) : units.bytesize / 2
      before = utf16_slice(units, 0, caret)
      broke = before.rindex(WORD_BREAK)
      preposing = broke ? before[0..broke] : ""
      target = broke ? before[(broke + 1)..] : before
      return { "reason" => "Nothing to complete here." } if target.empty?

      path = target.match?(/\A["']/) && preposing.match?(/(\A|[^\w])require(_relative)?\(? *\z/)
      member = target.match(/(&?\.|::)([^.:]*)\z/) unless path
      start = member ? member.begin(2) : 0
      names = candidates(preposing, target, utf16_slice(units, caret, units.bytesize / 2 - caret), member)
      prefix = target[0, start]
      words = names.select { |name| name.start_with?(prefix) }.map { |name| name[start..] }.reject(&:empty?)
      words = command_free(words) unless member
      words = words.uniq.sort.first(COMPLETION_LIMIT)
      return { "reason" => "Nothing completes “#{target}”." } if words.empty?

      candidates = words.map { |word| { "text" => word, "kind" => path ? "path" : kind(word, member) } }
      { "from" => caret - utf16_size(target[start..]), "receiver" => receiver(member && target[0, member.begin(1)]), "candidates" => candidates }
    rescue *INSPECT_FAILURES => error
      { "reason" => "Completion raised #{class_name(error)}." }
    end

    # `length` UTF-16 code units of `units` from `from`, as text. A surrogate pair cut in two is
    # dropped.
    def utf16_slice(units, from, length)
      units.byteslice(from * 2, length * 2).force_encoding(Encoding::UTF_16LE).encode(Encoding::UTF_8, invalid: :replace, undef: :replace, replace: "")
    end

    def utf16_size(text)
      text.encode(Encoding::UTF_16LE).bytesize / 2
    end

    # What the completor offers for `target`. RegexpCompletor finds a member's receiver by
    # evaluating its text, which is left alone when that text would call a method: a receiver
    # written with a call in it, before a `::`.
    def candidates(preposing, target, postposing, member)
      return [] if @completor.class.name == "IRB::RegexpCompletor" && calls_method?(target, member)

      @completor.completion_candidates(preposing, target, postposing, bind: @binding).map(&:to_s)
    end

    # Whether `RegexpCompletor` would evaluate a receiver that is more than a name for `target`.
    def calls_method?(target, member)
      member && member[1] == "::" && target.match?(/\A[A-Z]/) && !target[0, member.begin(1)].match?(/\A[\w:]+\z/)
    end

    # `words` without IRB's commands, which the loop does not have, unless a name of the same
    # spelling is in scope.
    def command_free(words)
      return words unless defined?(IRB::Command) && IRB::Command.respond_to?(:command_names)

      commands = IRB::Command.command_names
      words.reject { |word| commands.include?(word) && !in_scope?(word) }
    end

    def in_scope?(word)
      @binding.local_variables.include?(word.to_sym) || RESPONDS.bind(@binding.receiver).call(word, true)
    end

    # What kind of name `word` is, told by how it is spelled and where it is: after a `.` or a
    # `::` when `member`.
    def kind(word, member)
      if member then word.match?(/\A[[:upper:]]/) ? "constant" : "method"
      elsif word.start_with?("@@") then "cvar"
      elsif word.start_with?("@") then "ivar"
      elsif word.start_with?("$") then "gvar"
      elsif word.start_with?(":") then "symbol"
      elsif KEYWORDS.include?(word) then "keyword"
      elsif @binding.local_variables.include?(word.to_sym) then "local"
      elsif word.match?(/\A[[:upper:]]/) then "constant"
      else "method"
      end
    end

    # What a completion's member was asked of: the class of a literal, or of a variable's value,
    # and the receiver as it was typed otherwise. Nothing when it was no member.
    def receiver(text)
      return if text.nil?

      node = single_node(text)
      return text unless node

      name = node.class.name.split("::").last
      case name
      when "LocalVariableReadNode" then value_class(@binding.local_variable_get(node.name))
      when "InstanceVariableReadNode" then value_class(IVAR.bind(@binding.receiver).call(node.name))
      else LITERALS.fetch(name, text)
      end
    rescue *INSPECT_FAILURES
      text
    end

    # The one expression `text` is, read by Prism against the locals in scope, or nil when it is
    # more than one, is not Ruby, or Prism is not there.
    def single_node(text)
      return unless defined?(::Prism) && ::Prism.respond_to?(:parse)

      parsed = ::Prism.parse(text, scopes: [@binding.local_variables])
      body = parsed.value.statements.body
      body.first if parsed.success? && body.size == 1
    end

    def value_class(value)
      klass = class_of(value)
      klass.name || klass.inspect
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
    # result is inspected and laid out inside too, since inspecting a relation runs its query, and
    # the query belongs to the evaluation.
    #
    # `exit` and a signal such as SIGTERM end the process rather than the evaluation, except
    # Ctrl-C's `Interrupt`, which is the evaluation's answer.
    def evaluate(id, source)
      frame = interruptible do
        recorded(id, source) { Rails.application.executor.wrap { result(@binding.eval(source, "(repl)", 1)) } }
      end
      send_frame({ "type" => "result", "id" => id }.merge(frame))
    rescue SystemExit
      raise
    rescue Exception => error
      raise if error.is_a?(SignalException) && !error.is_a?(Interrupt)

      causes, causes_cut = causes(error)
      frame = { "type" => "error", "id" => id }.merge(failure(error)).merge("causes" => causes)
      frame["causes_cut"] = true if causes_cut
      send_frame(frame)
    end

    # `error`'s class, message and backtrace, with `cut` when the backtrace was.
    def failure(error)
      frames, cut = backtrace(error)
      failure = { "class" => class_name(error), "message" => utf8(error.message), "backtrace" => frames }
      failure["cut"] = true if cut
      failure
    end

    # The errors behind `error`, nearest first, each as `failure` gives it, and whether more were
    # left out. An error met again ends the chain.
    def causes(error)
      seen = { error => true }.compare_by_identity
      chain = []
      current = error
      while (cause = current.cause) && !seen.key?(cause)
        return [chain, true] if chain.size == CAUSE_LIMIT

        seen[cause] = true
        chain << failure(cause)
        current = cause
      end
      [chain, false]
    end

    # `error`'s backtrace from its first frame that is not the loop's own, such as the trap that
    # raised an `Interrupt`, down to the developer's last `(repl)` frame, so the loop's frames
    # under it are left out. An error with no such frame is cut where the loop's own begin, which
    # leaves nothing for a SyntaxError and everything for one raised on another thread. Then whole
    # frames up to `BACKTRACE_LIMIT` bytes, and whether some were left out.
    def backtrace(error)
      frames = (error.backtrace || []).map { |frame| utf8(frame) }
      last = frames.rindex { |frame| frame.start_with?("#{EVAL_FILE}:") }
      frames = last ? frames.first(last + 1).drop_while { |frame| loop_frame?(frame) } : frames.take_while { |frame| !loop_frame?(frame) }

      size = 0
      kept = frames.take_while { |frame| (size += frame.bytesize) <= BACKTRACE_LIMIT }
      [kept, kept.size < frames.size]
    end

    def loop_frame?(frame)
      frame.start_with?("#{LOOP_FILE}:")
    end

    # Runs the block inside the Initializer's `RailsLogReader.evaluation`, when the Host app has
    # one.
    def recorded(id, source, &block)
      return yield unless defined?(::RailsLogReader) && ::RailsLogReader.respond_to?(:evaluation)

      ::RailsLogReader.evaluation("repl-#{@token}-#{id}", source, sandbox: sandbox?, &block)
    end

    def sandbox?
      Rails.application.respond_to?(:sandbox?) && Rails.application.sandbox? == true
    end

    def interruptible
      @evaluating = true
      yield
    ensure
      @evaluating = false
    end

    # A result frame's fields for `value`. An `inspect` that raises, the value's own or one
    # inside it, leaves its node's label in place of its text, and the first one is noted. A
    # Relation is loaded once for all of it: see `LoadedOnce`.
    def result(value)
      @inspect_error = nil
      @shown = {}.compare_by_identity
      tree = tree(value)
      text, cut = pretty(value) { tree["inspect"] }
      frame = { "class" => class_name(value), "text" => text, "cut" => cut, "tree" => tree }
      frame["inspect_error"] = @inspect_error if @inspect_error
      frame
    ensure
      @shown = nil
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

    # `value` laid out breadth-first, until `NODE_LIMIT` nodes have been spent. A key or a name
    # is part of its entry's node, not one of its own. A value inside itself is a cycle, which
    # is not laid out again. One reached twice, but not from inside itself, is laid out twice.
    def tree(value)
      root = node(value)
      budget = NODE_LIMIT - 1
      queue = []
      queue << [value, root, [value]] if laid_out?(value, root["type"])
      until queue.empty?
        container, parent, ancestors = queue.shift
        children = parent[ENTRIES.fetch(parent["type"])] = []
        each_entry(container, parent["type"]) do |item, step, key|
          break if budget.zero?

          budget -= 1
          child = ancestors.any? { |each| each.equal?(item) } ? cycle(item) : node(item)
          child["step"] = step if step
          children << (key ? [key, child] : child)
          queue << [item, child, ancestors + [item]] if laid_out?(item, child["type"])
        end
        size = size(container, parent["type"])
        parent["more"] = size && size - children.size if size.nil? || children.size < size
      end
      root
    end

    # Yields each entry of a laid-out `value` of type class `type`: its value, the `[…]` step
    # that reaches it, when there is one, and its key. A Hash's key is its key's node, cut at
    # `INSPECT_LIMIT` with the step. A record's attribute, a member and an ivar are keyed by
    # name.
    def each_entry(value, type)
      case type
      when "hash"
        value.each_pair do |key, item|
          key_node = node(key)
          yield item, "[#{key_node['inspect']}]", key_node
        end
      when "array" then value.each_with_index { |item, index| yield item, "[#{index}]", nil }
      when "relation" then records(value).first(RELATION_LIMIT).each_with_index { |item, index| yield item, "[#{index}]", nil }
      when "set" then value.each { |item| yield item, nil, nil }
      when "struct" then value.each_pair { |name, item| yield item, "[#{name.inspect}]", name.to_s }
      when "data" then value.to_h.each { |name, item| yield item, nil, name.to_s }
      when "record"
        # An attribute is filtered when the filter changes even an empty value. A nil one is
        # left nil, as the record's own `inspect` leaves it.
        filter = ActiveSupport::ParameterFilter.new(value.class.filter_attributes)
        value.attribute_names.each do |name|
          item = value[name]
          item = FILTERED unless item.nil? || filter.filter_param(name, "") == ""
          yield item, "[#{name.to_sym.inspect}]", name
        end
      when "object" then ivars(value).each { |name| yield IVAR.bind(value).call(name), nil, name.to_s }
      end
    end

    # How many entries a laid-out `value` of type class `type` has, or nil for a Relation with
    # more than `RELATION_LIMIT` records, which is never counted.
    def size(value, type)
      case type
      when "relation"
        count = records(value).size
        count unless count > RELATION_LIMIT
      when "data" then value.class.members.size
      when "record" then value.attribute_names.size
      when "object" then ivars(value).size
      else value.size
      end
    end

    # The records a Relation's `inspect` shows, one more than `RELATION_LIMIT` at most.
    def records(relation)
      (shown(relation) || relation).records.take(inspect_limit(relation))
    end

    # How many records a Relation's `inspect` loads.
    def inspect_limit(relation)
      [relation.limit_value, RELATION_LIMIT + 1].compact.min
    end

    def ivars(value)
      IVARS.bind(value).call
    end

    # Whether `value`, of type class `type`, is laid out: a container, a record, a Relation
    # whose records load, or an object Ruby's own `inspect` writes, which shows its ivars.
    def laid_out?(value, type)
      case type
      when "object" then METHOD.bind(value).call(:inspect).owner == Kernel
      when "relation" then loads?(value)
      else ENTRIES.key?(type)
      end
    rescue TypeError, NameError
      false
    end

    def loads?(relation)
      records(relation)
      true
    rescue *INSPECT_FAILURES => error
      noted(error)
      false
    end

    # A node of `value`. One laid out, beyond a Hash or an Array, carries its class's name,
    # when its class has one.
    def node(value)
      return { "type" => "filtered", "inspect" => ActiveSupport::ParameterFilter::FILTERED } if FILTERED.equal?(value)

      text, cut = inspect_text(value)
      type = type_class(value)
      node = { "type" => type, "inspect" => text }
      node["cut"] = true if cut
      if type != "hash" && type != "array" && laid_out?(value, type)
        name = class_of(value).name
        node["class"] = name if name
      end
      node
    end

    # A value met again inside itself, which is Ruby's own `inspect` of it there.
    def cycle(value)
      text =
        case value
        when Hash then "{...}"
        when Array then "[...]"
        when Struct then "#<struct #{class_of(value).name}:...>"
        else
          if defined?(::Set) && ::Set === value then "#<Set: {...}>"
          elsif DATA && DATA === value then "#<data #{class_of(value).name}:...>"
          else "#{label(value).chomp('>')} ...>"
          end
        end
      { "type" => "cycle", "inspect" => text }
    end

    # What kind of value `value` is, told by `===`. A BasicObject, which lacks the `is_a?`
    # Active Support's `Time.===` asks, is an object.
    def type_class(value)
      return "object" unless Kernel === value

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
      when Struct then "struct"
      else
        if defined?(::Date) && ::Date === value then "time"
        elsif defined?(::BigDecimal) && ::BigDecimal === value then "decimal"
        elsif defined?(::Set) && ::Set === value then "set"
        elsif DATA && DATA === value then "data"
        elsif defined?(::ActiveRecord::Base) && ::ActiveRecord::Base === value then "record"
        elsif defined?(::ActiveRecord::Relation) && ::ActiveRecord::Relation === value then "relation"
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

    # `#<Post>`: the value's class.
    def label(value)
      klass = class_of(value)
      "#<#{klass.name || klass.inspect}>"
    end

    # The value's class, which a BasicObject, with no `class` of its own, answers too.
    def class_of(value)
      Kernel.instance_method(:class).bind(value).call
    rescue TypeError
      (class << value; self; end).superclass
    end

    def noted(error)
      @inspect_error ||= utf8("#{class_name(error)}: #{error.message}".byteslice(0, INSPECT_LIMIT))
    end

    # The name of `value`'s class, or its `inspect` for an anonymous class.
    def class_name(value)
      klass = class_of(value)
      klass.name || klass.inspect
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
