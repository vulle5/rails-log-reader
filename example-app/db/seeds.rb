# The Example app's seed. It exists so the Reader is developed against genuine ActiveRecord
# payloads — real tables, real associations, real query plans — rather than synthetic ones.
#
# Every value below is *written down*: names come from a list, titles from index arithmetic
# over two lists, and timestamps from a fixed base. There is no `Faker` and no `Random`,
# seeded or otherwise, so `bin/reset` restores this data rather than merely regenerating
# data of the same shape. `bin/rails db:seed` is safe over an already seeded database: it
# clears the three tables first, so seeding twice is seeding once.
#
# Locals rather than constants throughout, because a seed file gets loaded more than once
# in a process — `bin/ci` replants, and the test suite loads it per test — and a constant
# would warn every time.

base_time = Time.utc(2026, 1, 1, 9, 0, 0)

author_names = [
  "Ada Lovelace", "Grace Hopper", "Alan Turing", "Barbara Liskov",
  "Edsger Dijkstra", "Frances Allen", "Ken Thompson", "Radia Perlman",
  "Donald Knuth", "Margaret Hamilton", "Dennis Ritchie", "Karen Sparck Jones"
]

title_stems = [
  "Indexing", "Connection pools", "Eager loading", "Transactions", "Query plans",
  "Caching", "Migrations", "Foreign keys", "Serialization", "Background work"
]

title_tails = [
  "in practice", "revisited", "and what they cost", "for the impatient",
  "without the folklore", "one more time"
]

paragraphs = [
  "The database does not care how the query was written, only what it has to read.",
  "Most of the time here is spent waiting, and waiting is not the same as working.",
  "A number that only ever grows is a number nobody is watching.",
  "The fix was smaller than the explanation of why it was needed.",
  "It was correct on one row and wrong on ten thousand, which is the usual way round."
]

remarks = [
  "This matches what I measured last week.",
  "The second example is the one that bit us.",
  "I would draw the boundary somewhere else, but the reasoning holds.",
  "Worth saying that the defaults changed in the last release.",
  "The footnote is doing an enormous amount of work here."
]

posts_per_author = 5
comments_per_post = 5
# Every tenth post is left unpublished, so the index has drafts to leave out.
draft_every = 10

ActiveRecord::Base.transaction do
  Comment.delete_all
  Post.delete_all
  Author.delete_all

  authors = author_names.each_with_index.map do |name, index|
    at = base_time - (author_names.size - index).days

    Author.create!(
      name: name,
      email: "#{name.downcase.tr(" ", ".")}@example.com",
      bio: "#{name} writes here about #{title_stems[index % title_stems.size].downcase}.",
      created_at: at,
      updated_at: at
    )
  end

  posts = (0...(authors.size * posts_per_author)).map do |index|
    at = base_time + index.days

    Post.create!(
      author: authors[index % authors.size],
      title: "#{title_stems[index % title_stems.size]} #{title_tails[(index / title_stems.size) % title_tails.size]}",
      body: (0...3).map { |n| paragraphs[(index + n) % paragraphs.size] }.join("\n\n"),
      published_at: (at unless index % draft_every == draft_every - 1),
      created_at: at,
      updated_at: at
    )
  end

  posts.each_with_index do |post, post_index|
    comments_per_post.times do |n|
      at = post.created_at + (n + 1).hours

      Comment.create!(
        post: post,
        author: authors[(post_index + n + 1) % authors.size],
        body: remarks[(post_index + n) % remarks.size],
        created_at: at,
        updated_at: at
      )
    end
  end
end
