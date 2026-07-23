import { useEffect } from "react";
import { Link, useParams, Navigate } from "react-router-dom";
import blogPosts from "../data/blogPosts";

export default function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const post = blogPosts.find((p) => p.slug === slug);

  useEffect(() => {
    if (post) {
      document.title = `${post.title} — Silentbreak Blog`;
      // Update meta description
      let meta = document.querySelector('meta[name="description"]');
      if (!meta) {
        meta = document.createElement("meta");
        meta.setAttribute("name", "description");
        document.head.appendChild(meta);
      }
      meta.setAttribute("content", post.description);
    }
    return () => {
      document.title = "Silentbreak";
    };
  }, [post]);

  if (!post) {
    return <Navigate to="/blog" replace />;
  }

  return (
    <div className="min-h-screen bg-white">
      {/* Blog header */}
      <header className="border-b border-gray-100 px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <Link to="/" className="text-lg font-bold text-blue-600">
            🛡️ Silentbreak
          </Link>
          <Link to="/blog" className="text-sm text-gray-500 hover:text-gray-700">
            ← Back to Blog
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-12">
        <article>
          {/* Article header */}
          <header className="mb-8">
            <Link
              to="/blog"
              className="text-sm text-blue-600 hover:text-blue-700 mb-4 inline-block"
            >
              ← All articles
            </Link>
            <h1 className="text-3xl font-bold tracking-tight mt-2 mb-3 leading-tight">
              {post.title}
            </h1>
            <time className="text-sm text-gray-400">
              {new Date(post.date).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </time>
          </header>

          {/* Article body */}
          <div
            className="prose"
            dangerouslySetInnerHTML={{ __html: post.html }}
          />
        </article>
      </main>

      <footer className="border-t border-gray-100 py-8 px-4 text-center text-sm text-gray-400">
        &copy; {new Date().getFullYear()} Silentbreak. All rights reserved.
      </footer>
    </div>
  );
}
