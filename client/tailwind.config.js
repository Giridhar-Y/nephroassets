/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Repointed from the app's old near-black neutrals to the NephroPlus brand
        // palette (see nephroplus-brand skill) — every existing `text-ink`/`bg-accent`
        // usage across the app repaints automatically, no per-file migration needed.
        ink: "#01486F", // Deep Blue — primary text / authoritative headings
        accent: {
          DEFAULT: "#DD4D40", // Crimson Red — CTAs, active state, "plus" mark
          hover: "#C73228",
          light: "#FBEAE8"
        },
        brand: {
          crimson: "#DD4D40",
          crimsonHover: "#C73228",
          blue: "#569BD2",
          deepBlue: "#01486F",
          teal: "#47BEA4",
          rose: "#E6A3A3",
          sky: "#3EC6F3",
          skyDeep: "#0074BC"
        }
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        heading: ["Plus Jakarta Sans", "Inter", "ui-sans-serif", "system-ui", "sans-serif"]
      }
    }
  },
  plugins: []
};
