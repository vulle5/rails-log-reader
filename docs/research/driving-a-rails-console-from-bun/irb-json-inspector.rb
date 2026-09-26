# Throwaway experiment, loaded with a second `-r` beside irb-sentinel-prompt.rb and selected
# with `--inspect reader_json`: IRB's own RETURN line then carries JSON instead of `inspect`.
require "json"

IRB::Inspector.def_inspector([:reader_json]) do |value|
  JSON.generate({ class: value.class.name, inspect: value.inspect })
end
