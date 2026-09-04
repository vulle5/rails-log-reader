class PostsController < ApplicationController
  def index
    @posts = Post.published.includes(:author)
  end

  def show
    @post = Post.find(params[:id])
    @comments = @post.comments.includes(:author)
    @comment = @post.comments.new
    @authors = Author.order(:name)
  end
end
