const { Octokit } = require("@octokit/rest");
const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");
const { context } = require("@actions/github");
const { info, warning } = require("@actions/core");

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
                    // start_line: {
                    //     type: SchemaType.NUMBER,
                    //     description: "Start line number for the review comment",
                    //     nullable: false,
                    // },
                    line: {
                        type: SchemaType.NUMBER,
                        description: "Line number for the review comment",
                        nullable: false,
                    },
                    // start_side: {
                    //     type: SchemaType.STRING,
                    //     description: "Diff side for a multi line comment",
                    //     nullable: false,
                    // },
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
    info(`Existing comment: ${summaryComment}\n\n`);

    let baseCommitHash = context.payload.pull_request.base.sha;
    if (summaryComment) {
        const matches = summaryComment.body.match(
            /\[Last reviewed commit: (.*)\]/
        );
        if (matches && matches.length > 1) {
            baseCommitHash = matches[1];
        }
    }

    const commitIds = await getAllCommitIds(context);
    const headCommitHash = commitIds[commitIds.length - 1];

    if (baseCommitHash == headCommitHash) {
        warning("No new commits to review");
        return;
    }

    info(`Diff between: ${baseCommitHash}..${headCommitHash}`);
    const { data: diff } = await octokit.repos.compareCommits({
        owner: context.repo.owner,
        repo: context.repo.repo,
        base: baseCommitHash,
        head: headCommitHash,
        mediaType: {
            format: "diff",
        },
    });
    info(`Diff: ${diff}\n\n`);

    let review;
    if (summaryComment) {
        const { data: completeDiff } = await octokit.pulls.get({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: context.payload.pull_request.number,
            mediaType: {
                format: "diff",
            },
        });
        info(`Complete Diff: ${completeDiff}\n\n`);

        const result = await model.generateContent([
            "Review the following diff for a pull request. Generate a descriptive summary listing all the changes.",
            completeDiff,
            "Review the following diff for a commit in the pull request. Generate line by line suggestions according to coding best practices. Include the line number, diff side and file path for review comments.",
            diff,
        ]);
        const reviewJson = result.response.text();
        info(`Gemini response: ${reviewJson}\n\n`);

        review = JSON.parse(result.response.text());
    } else {
        const result = await model.generateContent([
            "Review the following diff for a pull request. Generate a descriptive summary listing all the changes. Also generate line by line suggestions according to coding best practices. Include the line number, diff side and file path for review comments.",
            diff,
        ]);
        const reviewJson = result.response.text();
        info(`Gemini response: ${reviewJson}\n\n`);

        review = JSON.parse(result.response.text());
    }

    // Add the summary as a general comment
    const summary = `AI Review Summary\n\n${review.summary}\n\n[Last reviewed commit: ${headCommitHash}]`;
    if (summaryComment) {
        await octokit.issues.updateComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            comment_id: summaryComment.id,
            body: summary,
        });
    } else {
        await octokit.issues.createComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: context.payload.pull_request.number,
            body: summary,
        });
    }

    // Add line-by-line comments
    for (const comment of review.reviewComments) {
        await octokit.pulls.createReviewComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: context.payload.pull_request.number,
            body: comment.text,
            commit_id: headCommitHash,
            path: comment.path,
            // start_side: comment.start_side,
            side: comment.side,
            // start_line: comment.start_line,
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
