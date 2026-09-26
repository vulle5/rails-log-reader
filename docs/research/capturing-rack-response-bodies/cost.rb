# frozen_string_literal: true

# Throwaway evidence for docs/research/capturing-rack-response-bodies.md: what carrying a
# response body inside a Sidecar line would cost, measured with the same `JSON.generate` the
# Initializer's `emit` uses.
#   ruby cost.rb

require "json"
require "benchmark"
require "base64"
require "tmpdir"

def ms(n = 50)
  best = Float::INFINITY
  n.times { best = [best, Benchmark.realtime { yield } * 1000].min }
  best.round(3)
end

def json_body(records)
  JSON.generate(Array.new(records) { |i| { id: i, title: "Post #{i}", body: "x" * 120, tags: %w[a b] } })
end

puts "Ruby #{RUBY_VERSION}, json #{JSON::VERSION}"
puts
puts "A JSON body carried as one string field of an envelope"
puts format("%-10s %12s %14s %8s %14s %14s", "records", "body bytes", "line bytes", "ratio", "generate ms", "join+scan ms")
[1, 10, 100, 350, 4000].each do |records|
  body = json_body(records)
  line = JSON.generate({ v: 3, type: "response_body", payload: { body: } })
  parts = [body] # what a Rack Array body holds
  gen = ms { JSON.generate({ v: 3, type: "response_body", payload: { body: } }) }
  scan = ms { s = parts.join; s.valid_encoding? }
  puts format("%-10d %12d %14d %8.2f %14.3f %14.3f", records, body.bytesize, line.bytesize,
    line.bytesize.fdiv(body.bytesize), gen, scan)
end

puts
xml = +"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<posts>"
350.times { |i| xml << "<post id=\"#{i}\"><title>Post #{i}</title><body>#{'x' * 120}</body></post>" }
xml << "</posts>"
xml_line = JSON.generate({ payload: { body: xml } })
puts "An XML body of #{xml.bytesize} B becomes #{xml_line.bytesize} B on a line " \
     "(#{xml_line.bytesize.fdiv(xml.bytesize).round(2)}x)"

puts
puts "Binary bodies"
[64 * 1024, 1024 * 1024, 10 * 1024 * 1024].each do |size|
  bytes = Random.new(1).bytes(size)
  b64 = ms(10) { Base64.strict_encode64(bytes) }
  path = File.join(Dir.tmpdir, "probe-cost-#{size}.bin")
  File.binwrite(path, bytes)
  read_all = ms(10) { File.binread(path) }
  read_head = ms(10) { File.open(path, "rb") { |f| f.read(64 * 1024) } }
  stat = ms(10) { File.size(path) }
  puts format("%9d B: base64 %9d B (%.2fx) in %7.3f ms | File.binread %7.3f ms | first 64 KB %6.3f ms | File.size %6.4f ms",
    size, Base64.strict_encode64(bytes).bytesize, 4.0 / 3, b64, read_all, read_head, stat)
  File.delete(path)
end
