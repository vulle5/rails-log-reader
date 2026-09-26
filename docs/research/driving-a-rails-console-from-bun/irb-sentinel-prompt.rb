# Throwaway experiment, loaded into IRB with `-r` (after `bin/rails console --`). Turns
# IRB's own prompt and return format into framing a pipe reader can split on.
$stdout.sync = true # a pipe is block-buffered by default; nothing arrives until 8 KB or exit

IRB.conf[:AUTO_INDENT] = false # otherwise IRB pads every prompt with indentation spaces

IRB.conf[:PROMPT][:READER] = {
  PROMPT_I: "\u0000ready\u0000",      # a statement finished (or the console just started)
  PROMPT_S: "\u0000string:%l\u0000",  # inside an unterminated string literal
  PROMPT_C: "\u0000continue\u0000",   # an incomplete expression: send another line
  RETURN: "\u0000result\u0000%s\n"
}
