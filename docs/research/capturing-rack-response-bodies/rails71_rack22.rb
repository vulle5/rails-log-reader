# frozen_string_literal: true

# probe.rb again, on the oldest pairing the Initializer accepts: Rails 7.1 on Rack 2.2, served
# by a Puma from before `rack.response_finished` existed. A one-file development-mode app,
# because the Example app is pinned to Rails 8.
#
#   BUNDLE_PATH=/tmp/rails71-bundle RAILS_ENV=development ruby rails71_rack22.rb

require "bundler/inline"

gemfile(true, quiet: true) do
  source "https://rubygems.org"
  gem "railties", "7.1.5.2"
  gem "actionpack", "7.1.5.2"
  gem "actionview", "7.1.5.2"
  gem "rack", "2.2.20"
  gem "puma", "6.6.1"
end

require "action_controller/railtie"
require "tmpdir"

class Rails71Probe < Rails::Application
  config.load_defaults 7.1
  config.root = Dir.mktmpdir("rails71")
  config.eager_load = false
  config.logger = Logger.new(File::NULL)
  config.hosts.clear
  config.secret_key_base = "x" * 64
end

Rails.application.initialize!

require_relative "probe"
Probe.run
