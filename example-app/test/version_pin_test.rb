require "test_helper"

# Two files pin the Ruby version, because they are read by different things: `.ruby-version`
# is what rbenv, rvm, chruby and asdf read, and `mise.toml` is what mise reads — current
# mise ignores `.ruby-version` entirely unless you turn idiomatic version files back on.
# `bin/setup` derives the version it prints from `.ruby-version`, so a drift between the two
# would have it name a version mise is not going to give you.
class VersionPinTest < ActiveSupport::TestCase
  test "mise.toml and .ruby-version pin the same Ruby" do
    dot_ruby_version = Rails.root.join(".ruby-version").read.strip.delete_prefix("ruby-")
    mise = Rails.root.join("mise.toml").read[/^\s*ruby\s*=\s*"([^"]+)"/, 1]

    assert mise, "mise.toml does not pin ruby"
    assert dot_ruby_version.start_with?(mise),
      "mise.toml pins ruby #{mise} but .ruby-version says #{dot_ruby_version}"
  end
end
