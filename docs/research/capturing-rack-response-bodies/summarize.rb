# frozen_string_literal: true

# Turns probe.rb's JSON into the one-screen-per-request text kept beside it as evidence.
#   ruby summarize.rb probe-output.json

require "json"

data = JSON.parse(File.read(ARGV.fetch(0)))
puts data["versions"].inspect

data["records"].each do |label, r|
  puts "== #{label}  #{r['method']} #{r['path']} -> #{r['status']} (client #{r.dig('client', 'status')}, #{r.dig('client', 'bytes')} B)"
  puts "  body at return: " + r["body_at_return"].map { |b| "#{b['class']}[#{b['responds'].join(',')}]" }.join(" > ")
  to_path = r["to_path"] ? " to_path=#{r['to_path'].inspect}" : ""
  puts "  served via: #{r['served_via'].inspect}  seen=#{r['captured_bytes']} B in #{r['captured_chunks']} chunks#{to_path}"
  puts "  seen bytes: #{r['captured_head']} (first chunk #{r['first_chunk_encoding'].inspect}, valid UTF-8: #{r['captured_valid_utf8']})"
  puts "  headers at return: #{r['headers_at_return']}"
  puts "  headers at close:  #{r['headers_at_close']}" if r["headers_at_close"] != r["headers_at_return"]
  puts "  headers client got: #{r.dig('client', 'headers')}"
  puts "  timeline (ms): " + r["timeline"].map { |what, at| "#{what} @#{at}" }.join(" | ")
  puts "  (no rack.response_finished in env)" if r["no_response_finished"]
end
