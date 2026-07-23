import { Link } from "react-router-dom";
import blogPosts from "../data/blogPosts";

export default function Blog() {
  return (
    <div className="min-h-screen bg-white">
      {/* Blog header */}
      <header className="border-b border-gray-100 px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <Link to="/" className="text-lg font-bold text-blue-600">
            🛡️ Silentbreak
          </Link>
          <span className="text-sm text-gray-500">Blog</span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-12">
        <h1 className="text-3xl font-bold tracking-tight mb-2">
          The Silentbreak Blog
        </h1>
        <p className="text-gray-500 mb-10">
          Insights on monitoring, analytics, and catching broken revenue paths
          before your clients do.
        </p>

        <div className="space-y-8">
          {blogPosts.map((post) => (
            <article
              key={post.slug}
              className="border-b border-gray-100 pb-8"
            >
              <time className="text-xs text-gray-400">
                {new Date(post.date).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </time>
              <h2 className="text-xl font-semibold mt-1 mb-2">
                <Link
                  to={`/blog/${post.slug}`}
                  className="text-gray-900 hover:text-blue-600 transition-colors"
                >
                  {post.title}
                </Link>
              </h2>
              <p className="text-sm text-gray-500 leading-relaxed">
                {post.excerpt}
              </p>
              <Link
                to={`/blog/${post.slug}`}
                className="inline-block mt-3 text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                Read more →
              </Link>
            </article>
          ))}
        </div>
      </main>

      <footer className="border-t border-gray-100 py-8 px-4 text-center text-sm text-gray-400">
        &copy; {new Date().getFullYear()} Silentbreak. All rights reserved.
      </footer>
    </div>
  );
}
