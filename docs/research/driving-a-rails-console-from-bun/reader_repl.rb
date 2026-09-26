# Throwaway experiment: a minimal eval loop speaking line-delimited JSON over stdio, to see
# what a custom loop hands back compared with IRB. Not a design — just enough to observe.
#
# Two ways in, both from the Host app's Rails root:
#
#   bin/rails runner --skip-executor /abs/path/reader_repl.rb
#   bin/rails console -- -r /abs/path/reader_repl.rb      # takes IRB over from inside IRB.setup
#
# Requests (one JSON object per line on stdin):
#   {"id":1,"op":"eval","code":"1 + 1"}
#   {"id":2,"op":"check","code":"def foo"}          -> is this code complete yet?
#   {"id":3,"op":"complete","code":"Post.cou"}
# Frames (one JSON object per line on stdout; anything else on stdout is not a frame):
#   {"event":"ready"}
#   {"id":1,"event":"stdout","text":"..."}         -> streamed live while the code runs
#   {"id":1,"event":"result","inspect":"2","class":"Integer"}
#   {"id":1,"event":"error","class":"RuntimeError","message":"boom","backtrace":[...]}
#   {"id":2,"event":"check","complete":false}
#   {"id":3,"event":"completions","candidates":[...]}

require "json"
require "irb"            # railties depends on irb, so it is always in the bundle
require "irb/completion"

PROTOCOL = $stdout.dup
PROTOCOL.sync = true
$stdout.sync = true

def frame(payload) = PROTOCOL.puts(JSON.generate(payload))

# Stands in for $stdout during one evaluation, so `puts` inside it comes back as frames
# tagged with the request's id, live, instead of mixing into the protocol stream.
class StdoutFrames
  def initialize(id) = @id = id
  def write(*parts)
    text = parts.join
    frame(id: @id, event: "stdout", text: text)
    text.bytesize
  end
  def <<(text) = tap { write(text) }
  def print(*parts) = write(*parts) && nil
  def puts(*lines) = write(lines.empty? ? "\n" : lines.map { |l| l.to_s.end_with?("\n") ? l.to_s : "#{l}\n" }.join) && nil
  def flush = self
  def sync = true
  def sync=(_); end
  def tty? = false
  alias_method :isatty, :tty?
end

# The console's `reload!` is an IRB helper method (railties' irb_console.rb), which a loop
# outside IRB does not have; this is the same one line it runs.
def reload!
  puts "Reloading..."
  Rails.application.reloader.reload!
end

workspace = TOPLEVEL_BINDING.dup # locals persist across evaluations, like IRB's own
lexer = IRB::RubyLex.new
completor = IRB::RegexpCompletor.new
evaluating = nil
main_thread = Thread.current

trap("INT") { main_thread.raise(Interrupt) if evaluating }

frame(event: "ready", run_kind_hint: defined?(Rails::Console) ? "console" : "not-console")

while (line = $stdin.gets)
  request = JSON.parse(line)
  id = request["id"]
  code = request["code"].to_s

  case request["op"]
  when "check"
    _continue, _opens, terminated = lexer.check_code_state(code, local_variables: workspace.local_variables)
    frame(id: id, event: "check", complete: terminated)
  when "complete"
    target = code[/[\w.:@$]*\z/].to_s
    preposing = code.delete_suffix(target)
    candidates = completor.completion_candidates(preposing, target, "", bind: workspace)
    frame(id: id, event: "completions", candidates: candidates.first(20))
  when "eval"
    begin
      evaluating = id
      $stdout = StdoutFrames.new(id)
      value = Rails.application.executor.wrap { workspace.eval(code, "(reader)", 1) }
      $stdout = STDOUT
      frame(id: id, event: "result", inspect: value.inspect, class: value.class.name)
    rescue Exception => e # rubocop:disable Lint/RescueException -- a REPL reports everything, including Interrupt
      $stdout = STDOUT
      raise if e.is_a?(SystemExit)
      frame(id: id, event: "error", class: e.class.name, message: e.message,
            backtrace: Rails.backtrace_cleaner.clean(e.backtrace || []).first(5))
    ensure
      evaluating = nil
      $stdout = STDOUT
    end
  end
end

exit # under `rails console -- -r`, never hand control back to IRB
