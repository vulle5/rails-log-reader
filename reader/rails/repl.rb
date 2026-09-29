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
#   out: {"type":"ready","pid":48213,"capabilities":[]}
#        {"type":"result","id":1,"text":"2","cut":false}
#        {"type":"error","id":1,"class":"NameError","message":"undefined local variable ..."}
#
# Fds 1 and 2 are the console's own, read by the Reader as plain text, so nothing the Host
# app prints can corrupt a frame. The loop ends, and the console with it, when fd 3 closes.

require "json"
require "pp"

module RailsLogReaderRepl
  # A result's text is cut at this many bytes.
  RESULT_LIMIT = 64 * 1024

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
      @binding = TOPLEVEL_BINDING.eval("binding")

      send_frame("type" => "ready", "pid" => Process.pid, "capabilities" => [])

      while (line = input.gets)
        frame = JSON.parse(line)
        evaluate(frame["id"], frame["input"]) if frame["type"] == "eval"
      end
    end

    private

    # Active Record's console hook sends every query to stderr as well. Those queries reach
    # the Reader through the Sidecar already, so the echo is detached.
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

    # Runs `source` the way a request runs, so the query cache is fresh and a reload is safe.
    def evaluate(id, source)
      value = Rails.application.executor.wrap { @binding.eval(source, "(repl)", 1) }
      text, cut = inspected(value)
      send_frame("type" => "result", "id" => id, "text" => text, "cut" => cut)
    rescue SystemExit
      raise
    rescue Exception => error
      send_frame("type" => "error", "id" => id, "class" => class_name(error), "message" => utf8(error.message))
    end

    def inspected(value)
      buffer = Bounded.new(RESULT_LIMIT)
      cut = true
      catch(buffer) do
        PP.pp(value, buffer, WIDTH)
        cut = false
      end
      text = cut ? buffer.text.byteslice(0, RESULT_LIMIT) : buffer.text.chomp
      [utf8(text), cut]
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
      @frames.write("#{JSON.generate(frame)}\n")
    end
  end
end

RailsLogReaderRepl.run
exit
