import typescriptEslint from "typescript-eslint";

export default [{
    files: ["**/*.ts"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint.plugin,
    },

    languageOptions: {
        parser: typescriptEslint.parser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        // "multi-line" matches the existing house style: single-line ifs do not require braces,
        // braces are required only when the body spans lines, avoiding a large reformat just to silence warnings.
        curly: ["warn", "multi-line"],
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",
    },
}];