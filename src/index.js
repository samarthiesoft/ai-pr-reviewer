const { Octokit } = require("@octokit/rest");
const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");
const { context } = require("@actions/github");
const { info } = require("@actions/core");

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
                    path: {
                        type: SchemaType.STRING,
                        description: "Path of the file",
                        nullable: false,
                    },
                    text: {
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
    const { data: issueComments } = await octokit.issues.listComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.payload.pull_request.number,
        per_page: 25,
    });
    const summaryComment = issueComments.findLast((issueComment) =>
        issueComment.body.startsWith("AI Review Summary")
    );
    info(`Existing comment: ${summaryComment.body}`);

    let baseCommitHash = context.payload.pull_request.base.sha;
    if (summaryComment) {
        const matches = summaryComment.body.match(/\[Last reviewed commit: (.*)\]/);
        if (matches && matches.length > 1) {
            baseCommitHash = matches[1]
        }
    }

    info(
        `Diff between: ${baseCommitHash}..${context.payload.pull_request.head.sha}`
    );
    const { data: diff } = await octokit.repos.compareCommits({
        owner: context.repo.owner,
        repo: context.repo.repo,
        base: baseCommitHash,
        head: context.payload.pull_request.head.sha,
        mediaType: {
            format: "diff",
        },
    });
    info(`Diff: ${diff}`);

    const prompt =
        "Take the following diff for a pull request and review it. Create a short multiline summary. Create line by line review comments and suggestions";

    const result = await model.generateContent([prompt, diff]);

    const reviewJson = result.response.text();
    const review = JSON.parse(result.response.text());
    info(`Gemini response: ${reviewJson}`);

    // Add the summary as a general comment
    await octokit.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.payload.pull_request.number,
        body: `AI Review Summary\n\n${review.summary}\n\n[Last reviewed commit: ${context.payload.pull_request.head.sha}]`,
    });

    // Add line-by-line comments
    for (const comment of review.reviewComments) {
        await octokit.pulls.createReviewComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: context.payload.pull_request.number,
            body: comment.text,
            commit_id: context.payload.pull_request.head.sha,
            path: comment.path,
            side: comment.side,
            line: comment.line,
        });
    }
}

async function getAllCommitIds(context) {
    const allCommits = [];
    let page = 1;
    let commits;
    if (context && context.payload && context.payload.pull_request != null) {
        do {
            commits = await octokit.pulls.listCommits({
                owner: context.repo.owner,
                repo: context.repo.repo,
                pull_number: context.payload.pull_request.number,
                per_page: 100,
                page,
            });

            allCommits.push(...commits.data.map((commit) => commit.sha));
            page++;
        } while (commits.data.length > 0);
    }

    return allCommits;
}

run();
