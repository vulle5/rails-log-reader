# frozen_string_literal: true

# Throwaway evidence for docs/research/capturing-rack-response-bodies.md. Not product code.
#
# Serves a set of controller actions through the app's real middleware stack, on a real
# in-process Puma, with a probe middleware sitting exactly where the Initializer's
# Middleware sits (`insert_after ActionDispatch::RequestId`). For every request it records
# what the body looks like when `@app.call` returns, which of `to_ary` / `each` / `to_path` /
# `call` the server then uses on it, what the headers say before and after, and a timeline
# of when each of those happens relative to `request.action_dispatch`'s finish,
# `rack.response_finished` and the client receiving the last byte.
#
# Rails 8.1 (the Example app):
#   cd example-app && PROBE_RUN=1 bin/rails runner ../docs/research/capturing-rack-response-bodies/probe.rb \
#     > /tmp/probe.json && ruby ../docs/research/capturing-rack-response-bodies/summarize.rb /tmp/probe.json
# Rails 7.1 on Rack 2.2: see rails71_rack22.rb beside this file.

require "json"
require "net/http"
require "puma"
require "puma/server"
require "puma/log_writer"
require "fileutils"
require "tmpdir"

module Probe
  CAP = 64 * 1024
  RECORDS = {}
  T0 = Process.clock_gettime(Process::CLOCK_MONOTONIC)

  def self.now_ms = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - T0) * 1000).round(2)

  def self.mark(rec, what) = (rec[:timeline] << [what, now_ms])

  def self.current = Thread.current[:probe_rec]

  FIXTURES = Dir.mktmpdir("probe")
  PNG = File.join(FIXTURES, "pixel.png")
  File.binwrite(PNG, "\x89PNG\r\n\x1A\n".b + ("\x00".b * 2048))
  PDF_BYTES = "%PDF-1.4\n".b + ("\xE2\xE3\xCF\xD3".b * 512) + "\n%%EOF\n".b

  # Walks the wrappers down to the object the app produced, without calling anything on them
  # that a server would (instance_variable_get only — this is a probe, not a design).
  def self.describe(body)
    chain = []
    8.times do
      break if body.nil?

      chain << {
        class: body.class.name,
        responds: %i[each to_ary to_path call close].select { |m| body.respond_to?(m) }
      }
      body =
        case body
        when Rack::BodyProxy then body.instance_variable_get(:@body)
        # No `response` reader before Rails 7.2.
        when ActionDispatch::Response::RackBody then body.instance_variable_get(:@response).stream
        when defined?(Rack::Deflater::GzipStream) && Rack::Deflater::GzipStream then body.instance_variable_get(:@body)
        end
    end
    chain
  end

  def self.snapshot(headers)
    keep = %w[content-type content-length content-encoding transfer-encoding content-disposition
              content-transfer-encoding etag cache-control x-request-id x-runtime server-timing
              x-sendfile last-modified]
    headers.to_h.transform_keys(&:downcase).slice(*keep)
  end

  class Middleware
    def initialize(app) = @app = app

    def call(env)
      rec = { path: env["PATH_INFO"], method: env["REQUEST_METHOD"], timeline: [], served_via: [] }
      RECORDS[env["HTTP_X_PROBE"]] = rec
      Thread.current[:probe_rec] = rec
      Probe.mark(rec, "middleware call")

      status, headers, body = @app.call(env)
      Probe.mark(rec, "middleware return")
      rec[:status] = status
      rec[:headers_at_return] = Probe.snapshot(headers)
      rec[:body_at_return] = Probe.describe(body)

      if (finished = env["rack.response_finished"])
        finished << proc { |*| Probe.mark(rec, "rack.response_finished"); rec[:headers_at_finished] = Probe.snapshot(headers) }
      else
        rec[:no_response_finished] = true
      end

      [status, headers, Tee.new(body, rec, headers)]
    end
  end

  # A body that forwards every optional method the wrapped one has, so the server keeps
  # choosing the path it would have chosen, and notes what it sees on the way through.
  class Tee
    def initialize(body, rec, headers)
      @body, @rec, @headers = body, rec, headers
      @captured = +"".b
      @bytes = 0
      @chunks = 0
    end

    def respond_to?(name, include_all = false)
      return @body.respond_to?(name, include_all) if %i[to_ary to_path call].include?(name)

      super
    end

    def each
      @rec[:served_via] << "each"
      Probe.mark(@rec, "each start")
      @body.each do |chunk|
        take(chunk)
        yield chunk
      end
      Probe.mark(@rec, "each end")
    end

    def to_ary
      @rec[:served_via] << "to_ary"
      Probe.mark(@rec, "to_ary")
      array = @body.to_ary
      array.each { |chunk| take(chunk) }
      array
    end

    def to_path
      @rec[:served_via] << "to_path"
      @body.to_path
    end

    def call(stream)
      @rec[:served_via] << "call"
      @body.call(stream)
    end

    def close
      return if @closed

      @closed = true
      Probe.mark(@rec, "body close")
      @body.close if @body.respond_to?(:close)
      @rec[:headers_at_close] = Probe.snapshot(@headers)
      @rec[:captured_bytes] = @bytes
      @rec[:captured_chunks] = @chunks
      # `inspect`, because a PDF's bytes cannot reach JSON.generate as they are.
      @rec[:captured_head] = @captured.byteslice(0, 40).inspect
      @rec[:first_chunk_encoding] = @first_encoding
      @rec[:captured_valid_utf8] = @captured.dup.force_encoding(Encoding::UTF_8).valid_encoding?
      if @bytes.zero? && @body.respond_to?(:to_path) && (path = @body.to_path)
        @rec[:to_path] = { path:, size: File.size?(path) }
      end
    end

    private
      def take(chunk)
        @chunks += 1
        @first_encoding ||= chunk.encoding.name
        @bytes += chunk.bytesize
        @captured << chunk.byteslice(0, CAP - @captured.bytesize) if @captured.bytesize < CAP
      end
  end

  class ProbeController < ActionController::Base
    skip_forgery_protection if respond_to?(:skip_forgery_protection)

    def json_small = render(json: { id: 1, title: "Hello", tags: %w[a b c], published: true })

    def json_large
      render json: Array.new(4000) { |i| { id: i, title: "Post #{i}", body: "x" * 120, tags: %w[a b] } }
    end

    def xml = render(xml: { id: 1, title: "Hello", tags: %w[a b c] }.to_xml(root: "post"))

    def html = render(html: "<h1>Hello</h1>".html_safe)

    def send_data_pdf = send_data(PDF_BYTES, type: "application/pdf", disposition: "inline", filename: "a.pdf")

    def send_file_png = send_file(PNG, type: "image/png", disposition: "inline")

    # ActiveStorage::DiskController#show's own body, via ActiveStorage::FileServer#serve_file —
    # the Example app does not load Active Storage, so the two lines it runs are run here.
    def rack_files
      Rack::Files.new(nil).serving(request, PNG).tap do |(status, headers, body)|
        self.status = status
        self.response_body = body
        headers.each { |name, value| response.headers[name] = value }
        response.headers["Content-Type"] = "image/png"
      end
    end

    def enumerator
      self.content_type = "text/plain"
      self.response_body = Enumerator.new { |y| 3.times { |i| y << "line #{i}\n" } }
    end

    def redirect = redirect_to("/probe/json_small")

    def boom = raise("boom")
  end

  class LiveController < ActionController::Base
    include ActionController::Live

    def sse
      response.headers["Content-Type"] = "text/event-stream"
      5.times do |i|
        response.stream.write("data: #{i}\n\n")
        sleep 0.02
      end
    ensure
      response.stream.close
    end

    # ActiveStorage::Blobs::ProxyController#show's shape: Content-Length set up front, then
    # ActiveStorage::Streaming#send_blob_stream → ActionController::Live#send_stream.
    def send_stream_blob
      response.headers["Content-Length"] = File.size(PNG).to_s
      send_stream(filename: "pixel.png", type: "image/png", disposition: "inline") do |stream|
        File.open(PNG, "rb") { |f| while (chunk = f.read(512)) do stream.write(chunk) end }
      end
    end
  end

  def self.routes
    routes = ActionDispatch::Routing::RouteSet.new
    routes.draw do
      %w[json_small json_large xml html send_data_pdf send_file_png rack_files enumerator redirect boom].each do |a|
        match "/probe/#{a}", to: "probe/probe##{a}", via: %i[get head]
      end
      get "/probe/sse", to: "probe/live#sse"
      get "/probe/send_stream_blob", to: "probe/live#send_stream_blob"
    end
    routes
  end

  def self.build(variant)
    stack = Rails.application.config.middleware.dup
    stack.insert_after ActionDispatch::RequestId, Middleware
    # Answers every request with a 500 page in a checkout that never ran `db:prepare`, and
    # touches nothing else about a body, so the probe runs without a database.
    if defined?(ActiveRecord::Migration::CheckPending) && stack.include?(ActiveRecord::Migration::CheckPending)
      stack.delete ActiveRecord::Migration::CheckPending
    end
    case variant
    when :deflater_inside then stack.use Rack::Deflater # what `config.middleware.use Rack::Deflater` does
    when :x_sendfile then stack.swap Rack::Sendfile, Rack::Sendfile, "X-Sendfile"
    end
    stack.build(routes)
  end

  def self.serve(app)
    server = Puma::Server.new(app, nil, min_threads: 0, max_threads: 4, log_writer: Puma::LogWriter.null)
    server.add_tcp_listener("127.0.0.1", 0)
    server.run
    [server, server.connected_ports.first]
  end

  def self.request(port, label, path, method: "GET", headers: {})
    klass = method == "HEAD" ? Net::HTTP::Head : Net::HTTP::Get
    req = klass.new(path, { "Accept-Encoding" => "identity", "X-Probe" => label }.merge(headers))
    res = Net::HTTP.start("127.0.0.1", port) { |http| http.request(req) }
    rec = RECORDS.fetch(label)
    mark(rec, "client got last byte")
    rec[:client] = {
      status: res.code.to_i, bytes: res.body.to_s.bytesize,
      headers: res.to_hash.transform_values { |v| v.join(", ") }.slice(
        "content-type", "content-length", "content-encoding", "transfer-encoding", "etag",
        "x-request-id", "x-runtime", "server-timing", "x-sendfile"
      )
    }
    res
  end

  def self.run
    ActiveSupport::Notifications.subscribe("request.action_dispatch") do |*|
      mark(current, "request.action_dispatch finish") if current
    end

    server, port = serve(build(:default))
    %w[json_small json_large xml html send_data_pdf send_file_png rack_files enumerator redirect sse
       send_stream_blob boom].each { |a| request(port, a, "/probe/#{a}") }
    request(port, "missing_route", "/probe/nope")
    etag = RECORDS["json_small"][:client][:headers]["etag"]
    request(port, "json_small_304", "/probe/json_small", headers: { "If-None-Match" => etag })
    request(port, "json_small_head", "/probe/json_small", method: "HEAD")
    request(port, "rack_files_range", "/probe/rack_files", headers: { "Range" => "bytes=0-99" })
    server.stop(true)

    server, port = serve(build(:deflater_inside))
    request(port, "json_large_deflater_inside", "/probe/json_large", headers: { "Accept-Encoding" => "gzip" })
    server.stop(true)

    server, port = serve(build(:x_sendfile))
    request(port, "send_file_png_x_sendfile", "/probe/send_file_png")
    request(port, "rack_files_x_sendfile", "/probe/rack_files")
    server.stop(true)

    puts JSON.pretty_generate(
      versions: { rails: Rails.version, rack: Rack.release, puma: Puma::Const::PUMA_VERSION, ruby: RUBY_VERSION },
      records: RECORDS
    )
  end
end

Probe.run if ENV["PROBE_RUN"]
