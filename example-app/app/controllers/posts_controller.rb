class PostsController < ApplicationController
  include PostPage

  def index
    @posts = Post.published.includes(:author)
  end

  def show
    @post = Post.find(params[:id])
    @comment = @post.comments.new
    load_post_page
  end
end
