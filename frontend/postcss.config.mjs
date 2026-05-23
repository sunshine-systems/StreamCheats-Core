// Tailwind v4 via the dedicated PostCSS plugin. Matches the marketing
// repo's setup so the design tokens in `app/globals.css` resolve
// utilities the same way (`bg-panel`, `text-foliage`, etc.).

const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
