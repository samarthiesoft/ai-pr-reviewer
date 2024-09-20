const path = require("path");

module.exports = {
    entry: "./src/index.js", // Entry point of your application
    target: "node", // Targeting Node.js environment
    output: {
        path: path.resolve(__dirname, "dist"), // Output directory
        filename: "index.js", // Output file
    },
    mode: "development", // Minify for production, or use 'development' for a readable format
};
