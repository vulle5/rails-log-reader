class Comment < ApplicationRecord
  belongs_to :post, counter_cache: true
  belongs_to :author

  validates :body, presence: true
end
