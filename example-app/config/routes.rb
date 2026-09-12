Rails.application.routes.draw do
  # Reveal health status on /up that returns 200 if the app boots with no exceptions, otherwise 500.
  # Can be used by load balancers and uptime monitors to verify that the app is live.
  get "up" => "rails/health#show", as: :rails_health_check

  resources :posts, only: %i[ index show ] do
    resources :comments, only: :create
  end

  # One GET per Scenario — the traffic shapes the Reader exists to make readable, reachable
  # by a button on the page below or by `curl` against the exact same line. No `bin/scenarios`
  # CLI and no launcher in the Reader: the endpoint is the whole interface.
  get "scenarios" => "scenarios#index"
  scope "scenarios", as: "scenario", controller: "scenarios" do
    get "parallel"
    get "n_plus_one"
    get "slow_query"
    get "hang"
    get "error"
    get "dual_homing"
    get "raw_sql"
    get "flood"
    get "partial_request"
    get "trailing_event"
  end

  root "posts#index"
end
