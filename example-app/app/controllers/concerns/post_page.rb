# `posts#show` renders a post's page, and `comments#create` re-renders it when the comment
# was invalid. Loading what that one template reads in one place is what keeps the two
# controllers from drifting apart from it.
module PostPage
  extend ActiveSupport::Concern

  private
    def load_post_page
      @comments = @post.comments.includes(:author)
      @authors = Author.order(:name)
    end
end
