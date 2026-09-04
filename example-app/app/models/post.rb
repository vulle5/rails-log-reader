class Post < ApplicationRecord
  belongs_to :author
  has_many :comments, -> { order(:created_at, :id) }, dependent: :destroy, inverse_of: :post

  validates :title, presence: true
  validates :body, presence: true

  scope :published, -> { where.not(published_at: nil).order(published_at: :desc) }

  def draft?
    published_at.nil?
  end
end
