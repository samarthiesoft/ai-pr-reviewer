const { Octokit } = require("@octokit/rest");
const {
    GoogleGenerativeAI,
    SchemaType,
    HarmCategory,
    HarmBlockThreshold,
} = require("@google/generative-ai");
const { context } = require("@actions/github");
const { info, warning } = require("@actions/core");
const shell = require("shelljs");
const fs = require("fs");

shell.cd(process.env.GITHUB_WORKSPACE);

const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
});

const GEMINI_OUTPUT_SCHEMA = {
    type: SchemaType.OBJECT,
    properties: {
        suggestions: {
            type: SchemaType.ARRAY,
            description: "Code suggestions",
            items: {
                type: SchemaType.OBJECT,
                properties: {
                    from_line: {
                        type: SchemaType.NUMBER,
                        description: "Code line number where the review starts",
                        nullable: false,
                    },
                    to_line: {
                        type: SchemaType.NUMBER,
                        description: "Code line number where the review ends",
                        nullable: false,
                    },
                    side: {
                        type: SchemaType.STRING,
                        description: "Side of the diff",
                        nullable: false,
                    },
                    filename: {
                        type: SchemaType.STRING,
                        description: "Name of the file",
                        nullable: false,
                    },
                    text: {
                        type: SchemaType.STRING,
                        description: "Main body of the suggestion",
                        nullable: false,
                    },
                },
            },
        },
        summary: {
            type: SchemaType.STRING,
            description: "Summary of the pull request",
            nullable: false,
        },
    },
};

// const schema = {
//     type: SchemaType.ARRAY,
//     description: "Pull request review",
//     items: {
//         type: SchemaType.OBJECT,
//         properties: {
//             from_line: {
//                 type: SchemaType.NUMBER,
//                 description: "code line number where the review starts",
//                 nullable: false,
//             },
//             to_line: {
//                 type: SchemaType.NUMBER,
//                 description: "code line number where the review ends",
//                 nullable: false,
//             },
//             side: {
//                 type: SchemaType.STRING,
//                 description: "side of the diff",
//                 nullable: false,
//             },
//             filename: {
//                 type: SchemaType.STRING,
//                 description: "name of the file",
//                 nullable: false,
//             },
//             text: {
//                 type: SchemaType.STRING,
//                 description: "main body of the suggestion",
//                 nullable: false,
//             },
//         },
//     },
// };

const safetySettings = [
    {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
];

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: "gemini-1.5-pro",
    safetySettings: safetySettings,
    generationConfig: {
        responseMimeType: "application/json",
        responseSchema: GEMINI_OUTPUT_SCHEMA,
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
    const diff = commitsDiff(baseCommitHash, headCommitHash);
    info(`Diff: ${diff}\n\n`);

    let review;
    if (summaryComment) {
        const completeDiff = commitsDiff(
            context.payload.pull_request.base.sha,
            headCommitHash
        );
        info(`Complete Diff: ${completeDiff}\n\n`);

        const result = await model.generateContentStream([
            `Here is a diff for a pull request in a project that uses node.js.
Review the code and suggest changes that will make the code more maintanable, less error prone while also checking for possible bugs and issues that could arise from the changes in the diff.
While suggesting the changes kindly mention the from_line and to_line and the filename for the supplied code that you are suggesting the change against.
For each suggestion mention the side. Can be LEFT or RIGHT. Use LEFT for deletions and RIGHT for additions.
The lines that start with a + sign are the added lines
The lines that start with a - sign are deleted lines
The lines with a , are unmodified`,
            diff,
            `Following is a diff for the complete pull request in a project that uses node.js.
Review all the changes and create a summary of all the changes as a list.`,
            completeDiff,
        ]);

        info(`Gemini response stream:\n`);
        let reviewJson = "";
        for await (const chunk of result.stream) {
            const chunkText = chunk.text().toString();
            reviewJson += chunkText;
            info(chunkText);
        }

        review = JSON.parse(reviewJson);
    } else {
        const result = await model.generateContentStream([
            `Here is a diff for a pull request in a project that uses node.js. 
Review the code and suggest changes that will make the code more maintanable, less error prone while also checking for possible bugs and issues that could arise from the changes in the diff.
While suggesting the changes kindly mention the from_line and to_line and the filename for the supplied code that you are suggesting the change against.
For each suggestion mention the side. Can be LEFT or RIGHT. Use LEFT for deletions and RIGHT for additions.
The lines that start with a + sign are the added lines
The lines that start with a - sign are deleted lines
The lines with a , are unmodified

Also create a summary of all the changes that are part of this PR.`,
            diff,
        ]);

        info(`Gemini response stream:\n`);
        let reviewJson = "";
        for await (const chunk of result.stream) {
            const chunkText = chunk.text().toString();
            reviewJson += chunkText;
            info(chunkText);
        }

        review = JSON.parse(reviewJson);
    }

    // Add the summary as a general comment
    const summary = `AI Review Summary\n\n${review.summary}\n\n[Last reviewed commit: ${headCommitHash}]`;
    // if (summaryComment) {
    //     await octokit.issues.updateComment({
    //         owner: context.repo.owner,
    //         repo: context.repo.repo,
    //         comment_id: summaryComment.id,
    //         body: summary,
    //     });
    // } else {
    await octokit.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.payload.pull_request.number,
        body: summary,
    });
    // }

    // Add line-by-line comments
    for (const comment of review.suggestions) {
        let requestData = {
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: context.payload.pull_request.number,
            body: comment.text,
            commit_id: headCommitHash,
            path: comment.filename,
            side: comment.side,
            line: comment.to_line,
        };

        if (comment.from_line < comment.to_line) {
            requestData.start_line = comment.from_line;
        }

        await octokit.pulls.createReviewComment(requestData);
    }
}

run();

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

function commitsDiff(baseCommitHash, headCommitHash) {
    return shell
        .exec(
            `git diff -W ${baseCommitHash}..${headCommitHash} | gawk '
match($0,"^@@ -([0-9]+),([0-9]+) [+]([0-9]+),([0-9]+) @@",a){
    left=a[1]
    ll=length(a[2])
    right=a[3]
    rl=length(a[4])
}
/^(---|\\+\\+\\+|[^-+ ])/{ print;next }
{ line=substr($0,2) }
/^[-]/{ printf "-%"ll"s %"rl"s:%s\\n",left++,""     ,line;next }
/^[+]/{ printf "+%"ll"s %"rl"s:%s\\n",""    ,right++,line;next }
        { printf " %"ll"s %"rl"s:%s\\n",left++,right++,line }
'`
        )
        .toString();
}
