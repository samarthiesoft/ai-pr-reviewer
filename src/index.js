const { Octokit } = require("@octokit/rest");
const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");
const { context } = require("@actions/github");

const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const schema = {
    type: SchemaType.OBJECT,
    properties: {
        summary: {
            type: SchemaType.STRING,
            description: "Summary of the pull request",
            nullable: false,
        },
        reviewComments: {
            type: SchemaType.ARRAY,
            description: "Pull request review",
            items: {
                type: SchemaType.OBJECT,
                properties: {
                    line: {
                        type: SchemaType.NUMBER,
                        description: "Line number for the review comment",
                        nullable: false,
                    },
                    side: {
                        type: SchemaType.STRING,
                        description: "Diff side for the comment",
                        nullable: false,
                    },
                    comment: {
                        type: SchemaType.STRING,
                        description: "Body of the review comment",
                        nullable: false,
                    },
                },
            },
        },
    },
};

const model = genAI.getGenerativeModel({
    model: "gemini-1.5-pro",
    generationConfig: {
        responseMimeType: "application/json",
        responseSchema: schema,
    },
});

async function run() {
    const { data: diff } = await octokit.pulls.get({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: context.payload.pull_request.number,
        mediaType: {
            format: "diff",
        },
    });

    const prompt =
        "Take the following diff for a pull request and review it. Create a short multiline summary. Create line by line review comments and suggestions";

    const result = await model.generateContent([prompt, diff]);

    const review = JSON.parse(result.response.text());

    // Add the summary as a general comment
    await octokit.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.payload.pull_request.number,
        body: review.summary,
    });

    // // Add line-by-line comments
    // for (const comment of lineComments) {
    //     await octokit.rest.pulls.createComment({
    //         owner: process.env.GITHUB_REPOSITORY_OWNER,
    //         repo: process.env.GITHUB_REPOSITORY_NAME,
    //         pull_number: pullRequestNumber,
    //         body: comment.text,
    //         path: comment.path,
    //         position: comment.position,
    //     });
    // }
}

run();
