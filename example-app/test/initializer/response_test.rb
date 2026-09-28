require "test_helper"
require "support/development_run"
require "net/http"

# The Middleware's body wrapper, and the one `response` event it writes per request when the
# body closes. Each Scenario is driven through the booted app, and the Run prints what its
# client received, so the event is checked against the response as it was actually sent.
class ResponseTest < ActiveSupport::TestCase
  # A real request, and what came back to the client: every header in the order it arrived,
  # the body, and its size. `content-length` is left out: Rack's MockResponse adds it while
  # buffering the body, and the app never set it. The body is scrubbed so a compressed one
  # prints.
  def self.received(path, method: :get, headers: {})
    <<~RUBY
      session = ActionDispatch::Integration::Session.new(Rails.application)
      session.host! "localhost"
      session.process(#{method.inspect}, #{path.inspect}, headers: #{headers.inspect})
      headers = session.response.headers.to_h.to_a.reject { |name, _| name == "content-length" }
      body = session.response.body
      puts JSON.generate(headers:, body: body.dup.force_encoding("UTF-8").scrub, size: body.bytesize)
    RUBY
  end

  UNCHANGED_SINCE = { "If-Modified-Since" => ScenariosController::UNCHANGED_SINCE.httpdate }.freeze

  test "a JSON response is one response event after its request_finish, carrying its request's id" do
    run = DevelopmentRun.boot(script: self.class.received("/scenarios/json"))

    assert run.booted?, run.output
    received = JSON.parse(run.output)
    finish = run.events_of("request_finish").sole
    response = run.events_of("response").sole

    assert_equal finish["request_id"], response["request_id"]
    assert_operator response["seq"], :>, finish["seq"], "the body closes after the request finishes"

    payload = response["payload"]
    assert_equal 200, payload["status"]
    assert_equal "application/json; charset=utf-8", payload["content_type"]
    assert_equal "json", payload["format"]
    assert_equal received["body"], payload["body"], "the body travels as the text the app sent"
    assert_equal received["body"].bytesize, payload["size"]
    assert_nil payload["no_body"]
    assert_nil response["truncated"]
  end

  test "headers are complete and in the order the client received them, those set above the Middleware included" do
    run = DevelopmentRun.boot(script: self.class.received("/scenarios/json"))

    assert run.booted?, run.output
    received = JSON.parse(run.output)
    headers = run.events_of("response").sole["payload"]["headers"]

    assert_equal received["headers"], headers
    assert_includes headers.map(&:first), "x-request-id", "RequestId sets it after the Middleware returns"
    assert_includes headers.map(&:first), "x-runtime", "Rack::Runtime sets it after the Middleware returns"
  end

  test "an XML response keeps its body, with format xml" do
    run = DevelopmentRun.boot(script: self.class.received("/scenarios/xml"))

    assert run.booted?, run.output
    received = JSON.parse(run.output)
    payload = run.events_of("response").sole["payload"]

    assert_equal "xml", payload["format"]
    assert_equal "application/xml; charset=utf-8", payload["content_type"]
    assert_equal received["body"], payload["body"]
    assert_match(/\A<\?xml/, payload["body"])
  end

  test "a JSON body over 64 KB is cut like every field, its original size under truncated.body" do
    run = DevelopmentRun.boot(script: self.class.received("/scenarios/big_json"))

    assert run.booted?, run.output
    received = JSON.parse(run.output)
    response = run.events_of("response").sole
    payload = response["payload"]

    assert_operator received["body"].bytesize, :>, 64 * 1024, "the Scenario has to be over the cap"
    assert_equal({ "body" => received["body"].bytesize }, response["truncated"])
    assert_equal received["body"].bytesize, payload["size"], "size is what the app sent, not what was kept"
    assert_equal 64 * 1024, payload["body"].bytesize
    assert received["body"].start_with?(payload["body"]), "the cut keeps the start of the body"
  end

  test "an HTML page has its headers, status, content type and size, and no body for the type reason" do
    run = DevelopmentRun.boot(script: self.class.received("/posts"))

    assert run.booted?, run.output
    received = JSON.parse(run.output)
    payload = run.events_of("response").sole["payload"]

    assert_equal 200, payload["status"]
    assert_equal "text/html; charset=utf-8", payload["content_type"]
    assert_equal received["body"].bytesize, payload["size"]
    assert_equal received["headers"], payload["headers"]
    assert_equal({ "reason" => "type", "content_type" => "text/html; charset=utf-8" }, payload["no_body"])
    assert_nil payload["body"]
    assert_nil payload["format"]
  end

  test "a PDF sent with send_file has its type and the file's size, and no body for the type reason" do
    run = DevelopmentRun.boot(script: self.class.received("/scenarios/pdf"))

    assert run.booted?, run.output
    received = JSON.parse(run.output)
    payload = run.events_of("response").sole["payload"]

    assert_equal "application/pdf", payload["content_type"]
    assert_equal({ "reason" => "type", "content_type" => "application/pdf" }, payload["no_body"])
    assert_equal received["size"], payload["size"]
    assert_equal File.size(ScenariosController::REPORT_PDF), payload["size"]
    assert_nil payload["body"]
  end

  test "a streamed CSV has no body for the streamed reason, and no size" do
    run = DevelopmentRun.boot(script: self.class.received("/scenarios/streamed_csv"))

    assert run.booted?, run.output
    received = JSON.parse(run.output)
    payload = run.events_of("response").sole["payload"]

    assert_match(/\Aid,title,comments\n/, received["body"], "the client still gets the whole CSV")
    assert_equal "text/csv", payload["content_type"]
    assert_equal({ "reason" => "streamed" }, payload["no_body"])
    assert_nil payload["size"], "a stream's size is not known without reading it"
    assert_nil payload["body"]
  end

  test "a gzip-encoded JSON body has no body for the encoded reason, with its encoding and compressed size" do
    run = DevelopmentRun.boot(script: self.class.received("/scenarios/gzip_json"))

    assert run.booted?, run.output
    received = JSON.parse(run.output)
    payload = run.events_of("response").sole["payload"]

    assert_equal "application/json; charset=utf-8", payload["content_type"]
    assert_equal({ "reason" => "encoded", "content_encoding" => "gzip" }, payload["no_body"])
    assert_equal received["size"], payload["size"]
    assert_nil payload["body"]
    assert_nil payload["format"]
  end

  test "a 204, a 304, a redirect and a HEAD request have no body for the empty reason" do
    script = [
      self.class.received("/scenarios/no_content"),
      self.class.received("/scenarios/conditional_get", headers: UNCHANGED_SINCE),
      self.class.received("/scenarios/redirect"),
      self.class.received("/scenarios/json", method: :head)
    ].join("\n")
    run = DevelopmentRun.boot(script:)

    assert run.booted?, run.output
    responses = run.events_of("response").map { |event| event["payload"] }

    assert_equal [204, 304, 302, 200], responses.map { |payload| payload["status"] }
    responses.each { |payload| assert_equal({ "reason" => "empty" }, payload["no_body"]) }
    assert_includes responses[2]["headers"], %w[location http://localhost/scenarios/json],
      "a redirect's target is already in its headers"
  end

  test "a hijacked connection's response has no headers and no body, and its request still finishes first" do
    run = DevelopmentRun.boot(script: <<~'RUBY')
      require "stringio"
      socket = StringIO.new
      session = ActionDispatch::Integration::Session.new(Rails.application)
      session.host! "localhost"
      session.get("/scenarios/hijack", env: { "rack.hijack?" => true, "rack.hijack" => -> { socket } })
      puts JSON.generate(written: socket.string, closed: socket.closed?)
    RUBY

    assert run.booted?, run.output
    received = JSON.parse(run.output)
    finish = run.events_of("request_finish").sole
    response = run.events_of("response").sole

    assert_equal ScenariosController::HIJACKED_REPLY, received["written"], "the app wrote to the socket itself"
    assert received["closed"]
    assert_equal finish["request_id"], response["request_id"]
    assert_operator response["seq"], :>, finish["seq"]
    assert_equal [], response["payload"]["headers"]
    assert_nil response["payload"]["content_type"]
    assert_nil response["payload"]["size"]
    assert_equal({ "reason" => "hijacked" }, response["payload"]["no_body"])
  end

  test "a redirect that sends a body is still empty" do
    run = DevelopmentRun.boot(script: <<~'RUBY')
      require "rack/mock_request"
      app = ->(_env) { [302, { "location" => "/next", "content-type" => "text/html" }, ["You are being redirected."]] }
      _, _, wrapped = RailsLogReader::Middleware.new(app).call(Rack::MockRequest.env_for("/x"))
      wrapped.to_ary
    RUBY

    assert run.booted?, run.output
    assert_equal({ "reason" => "empty" }, run.events_of("response").sole["payload"]["no_body"])
  end

  test "a response hijacked by its rack.hijack header is hijacked too" do
    run = DevelopmentRun.boot(script: <<~'RUBY')
      require "rack/mock_request"
      app = ->(_env) { [200, { "rack.hijack" => ->(socket) { socket.close } }, []] }
      _, _, wrapped = RailsLogReader::Middleware.new(app).call(Rack::MockRequest.env_for("/x"))
      wrapped.close
    RUBY

    assert run.booted?, run.output
    payload = run.events_of("response").sole["payload"]
    assert_equal [], payload["headers"]
    assert_equal({ "reason" => "hijacked" }, payload["no_body"])
  end

  test "a request that never routed still gets its response event" do
    run = DevelopmentRun.boot(script: self.class.received("/no/such/route"))

    assert run.booted?, run.output
    finish = run.events_of("request_finish").sole
    response = run.events_of("response").sole

    assert_equal finish["request_id"], response["request_id"]
    assert_equal 404, response["payload"]["status"]
  end

  # Each request as [method, path, headers], and what a real Puma's Run records for it: the
  # format of a kept body, or the reason there is none.
  SERVED = {
    ["GET", "/scenarios/json", {}] => "json",
    ["GET", "/scenarios/xml", {}] => "xml",
    ["GET", "/scenarios/big_json", {}] => "json",
    ["GET", "/scenarios/pdf", {}] => "type",
    ["GET", "/scenarios/streamed_csv", {}] => "streamed",
    ["GET", "/scenarios/gzip_json", {}] => "encoded",
    ["GET", "/scenarios/no_content", {}] => "empty",
    ["GET", "/scenarios/conditional_get", UNCHANGED_SINCE] => "empty",
    ["GET", "/scenarios/redirect", {}] => "empty",
    ["HEAD", "/scenarios/json", {}] => "empty",
    ["GET", "/scenarios/hijack", {}] => "hijacked"
  }.freeze

  test "what a real Puma sends is byte-identical with and without the Initializer, and each is recorded as what it is" do
    enabled = serve_and_fetch(SERVED.keys, initializer: true)
    untouched = serve_and_fetch(SERVED.keys, initializer: false)

    SERVED.each_key do |request|
      assert_equal untouched[:received][request], enabled[:received][request], "#{request[0, 2].join(" ")} changed on its way to the client"
    end
    assert_empty untouched[:result].events_of("response")

    starts = enabled[:result].events_of("request_start")
    finishes = enabled[:result].events_of("request_finish")
    responses = enabled[:result].events_of("response").index_by { |response| response["request_id"] }
    assert_equal SERVED.size, starts.size
    SERVED.each_value.zip(starts) do |expected, start|
      payload = responses.fetch(start["request_id"])["payload"]
      assert_equal expected, payload["format"] || payload["no_body"]["reason"],
        "#{start["payload"]["method"]} #{start["payload"]["path"]}"
    end
    assert_equal starts.map { |start| start["request_id"] }.sort, finishes.map { |finish| finish["request_id"] }.sort,
      "every request finishes, the hijacked one included"
    assert_equal enabled[:received][SERVED.keys.first][:body], responses.fetch(starts.first["request_id"])["payload"]["body"]
  end

  test "log/development.log gains nothing from capturing a response" do
    enabled = DevelopmentRun.boot(script: self.class.received("/scenarios/json"))
    untouched = DevelopmentRun.boot(script: self.class.received("/scenarios/json"), initializer: false)

    assert enabled.booted?, enabled.output
    assert untouched.booted?, untouched.output
    assert enabled.events_of("response").any?, "the Run under test was not capturing responses"

    # Durations, allocations and the request's timestamp differ between any two Runs.
    masked = ->(log) { log.gsub(/\d+(\.\d+)?/, "N") }
    assert_equal masked.(untouched.development_log), masked.(enabled.development_log)
  end

  test "a disabled Initializer wraps nothing" do
    run = DevelopmentRun.boot(script: <<~'RUBY')
      require "rack/mock_request"
      body = Rack::BodyProxy.new(["{}"]) { }
      RailsLogReader.instance_variable_set(:@disabled, true)
      app = ->(_env) { [200, { "content-type" => "application/json" }, body] }
      _, _, returned = RailsLogReader::Middleware.new(app).call(Rack::MockRequest.env_for("/x"))
      puts "same body: #{returned.equal?(body)}"
    RUBY

    assert run.booted?, run.output
    assert_includes run.output, "same body: true"
  end

  test "the wrapper answers respond_to? as the body it wraps does, and forwards to_path and call" do
    run = DevelopmentRun.boot(script: <<~'RUBY')
      require "rack/mock_request"
      file = Struct.new(:path) { def each = yield("file"); def to_path = path }.new("/tmp/report.pdf")
      streaming = Object.new
      def streaming.call(stream) = stream.write("streamed")

      [["in memory", ["{}"]], ["file", file], ["streaming", streaming]].each do |name, inner|
        body = Rack::BodyProxy.new(inner) { }
        app = ->(_env) { [200, { "content-type" => "application/json" }, body] }
        _, _, wrapped = RailsLogReader::Middleware.new(app).call(Rack::MockRequest.env_for("/x"))
        answers = %i[each to_ary to_path call close].map { |method| wrapped.respond_to?(method) == body.respond_to?(method) }
        puts "#{name}: #{answers.all?}"
        puts "#{name} to_path: #{wrapped.to_path}" if body.respond_to?(:to_path)
        if body.respond_to?(:call)
          written = +""
          wrapped.call(Struct.new(:out) { def write(text) = out << text }.new(written))
          puts "#{name} call: #{written}"
        end
        wrapped.close
      end
    RUBY

    assert run.booted?, run.output
    assert_includes run.output, "in memory: true"
    assert_includes run.output, "file: true"
    assert_includes run.output, "streaming: true"
    assert_includes run.output, "file to_path: /tmp/report.pdf"
    assert_includes run.output, "streaming call: streamed"
    assert_equal 3, run.events_of("response").size, "each body emits once, when it closes"
  end

  test "a body closed twice emits once" do
    run = DevelopmentRun.boot(script: <<~'RUBY')
      require "rack/mock_request"
      app = ->(_env) { [200, { "content-type" => "application/json" }, Rack::BodyProxy.new(["{}"]) { }] }
      _, _, wrapped = RailsLogReader::Middleware.new(app).call(Rack::MockRequest.env_for("/x"))
      wrapped.to_ary
      wrapped.close
    RUBY

    assert run.booted?, run.output
    response = run.events_of("response").sole
    assert_equal "{}", response["payload"]["body"]
  end

  private
    # One request at a time, in order. `accept-encoding` is set, so Net::HTTP hands the body
    # back as it arrived rather than decompressing it.
    def serve_and_fetch(requests, initializer:)
      DevelopmentRun.shared_root(initializer:) do |root|
        served = DevelopmentRun.serve(root:)
        # Header values such as `x-request-id` and `x-runtime` differ between any two Runs.
        received = requests.to_h do |method, path, headers|
          response = Net::HTTP.start("127.0.0.1", served.port) do |http|
            http.send_request(method, path, nil, { "accept-encoding" => "gzip" }.merge(headers))
          end
          [[method, path, headers], { status: response.code, header_names: response.to_hash.keys, body: response.body.to_s.b }]
        end

        Process.kill("TERM", served.pid)
        _, status = Process.wait2(served.pid)
        { received:, result: served.finish(status) }
      end
    end
end
