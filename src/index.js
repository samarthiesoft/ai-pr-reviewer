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

shell.cd(process.env.GIT_REPO_PATH);

const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
});

const GEMINI_OUTPUT_SCHEMA = {
    type: SchemaType.ARRAY,
    description: "Code suggestions",
    items: {
        type: SchemaType.OBJECT,
        properties: {
            from_line: {
                type: SchemaType.NUMBER,
                description: "code line number where the review starts",
                nullable: false,
            },
            to_line: {
                type: SchemaType.NUMBER,
                description: "code line number where the review ends",
                nullable: false,
            },
            side: {
                type: SchemaType.STRING,
                description: "side of the diff",
                nullable: false,
            },
            filename: {
                type: SchemaType.STRING,
                description: "name of the file",
                nullable: false,
            },
            text: {
                type: SchemaType.STRING,
                description: "main body of the suggestion",
                nullable: false,
            },
        },
        required: ["from_line", "to_line", "side", "filename", "text"],
    },
};

const GEMINI_SAFETY_SETTINGS = [
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
const summaryModel = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    safetySettings: GEMINI_SAFETY_SETTINGS,
});
const suggestionsModel = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    safetySettings: GEMINI_SAFETY_SETTINGS,
    generationConfig: {
        responseMimeType: "application/json",
        responseSchema: GEMINI_OUTPUT_SCHEMA,
    },
});

async function run() {
    const summaryComment = await findSummaryComment(context);
    info(`Existing comment: ${summaryComment}\n\n`);

    // Find the base and head commits for the review
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
    const fileDiffs = getFileDiffsWithLineNumbers(
        baseCommitHash,
        headCommitHash
    );
    const prDiff = getDiffBetweenCommits(
        context.payload.pull_request.base.sha,
        headCommitHash
    );
    info(`PR Diff: ${prDiff}\n\n`);

    info(`Gemini response - Summary:\n`);
    let summary = "";
    const summaryStream = await getSummaryStream(prDiff);
    for await (const chunk of summaryStream.stream) {
        const chunkText = chunk.text().toString();
        summary += chunkText;
        info(chunkText);
    }
    if (summary.trim() == "") {
        warning("Empty summary. Stopping");
        return;
    }
    summary = `AI Review Summary\n\n${summary}\n\n[Last reviewed commit: ${headCommitHash}]`;

    info(`Gemini response - Suggestions:\n`);
    let suggestionsJson = "";
    const suggestionsStream = await getSuggestionsStream(fileDiffs);
    for await (const chunk of suggestionsStream.stream) {
        const chunkText = chunk.text().toString();
        suggestionsJson += chunkText;
        info(chunkText);
    }
    const suggestions = JSON.parse(suggestionsJson);

    // Add the summary as a general comment
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
    for (const comment of suggestions) {
        let requestData = {
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: context.payload.pull_request.number,
            body: comment.text,
            commit_id: headCommitHash,
            path: comment.filename.replace(/^\/+|\/$/g),
            side: comment.side,
            line: comment.to_line,
        };

        if (comment.from_line < comment.to_line) {
            requestData.start_line = comment.from_line;
        }

        try {
            await octokit.pulls.createReviewComment(requestData);
        } catch (error) {
            warning(error.toString());
        }
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

function getDiffBetweenCommits(baseCommitHash, headCommitHash) {
    return shell
        .exec(
            `cd ${process.env.GIT_REPO_PATH} && git diff -W ${baseCommitHash}..${headCommitHash}`
        )
        .toString();
}

function getFileDiffsWithLineNumbers(baseCommitHash, headCommitHash) {
    const fileNames = shell
        .exec(
            `cd ${process.env.GIT_REPO_PATH} && git diff --name-only ${baseCommitHash}..${headCommitHash}`
        )
        .toString()
        .split("\n");

    return fileNames.map((fileName) =>
        shell
            .exec(
                `cd ${process.env.GIT_REPO_PATH} && git diff -W ${baseCommitHash}..${headCommitHash} ${fileName} | gawk '
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
            .toString()
    );
}

async function getSummaryStream(diff) {
    return await summaryModel.generateContentStream([
        `Here is a diff for a pull request in a project. 
Review the code and create a summary that includes a high level overview of all the changes made in the PR.
The lines that start with a + sign are the added lines
The lines that start with a - sign are deleted lines
The lines with a , are unmodified`,
        diff,
    ]);
}

async function getSuggestionsStream(fileDiffs) {
    return await suggestionsModel.generateContentStream([
        `Here are individual file diffs for a pull request in a project. 
Review the code and suggest changes that will make the code more maintanable, less error prone while also checking for possible bugs and issues that could arise from the changes in the diff.
While suggesting the changes kindly mention the from_line and to_line and the filename for the supplied code that you are suggesting the change against.
For each suggestion mention the side. Can be LEFT or RIGHT. Use LEFT for deletions and RIGHT for additions.
Strictly avoid repeating suggestions and all suggestions should strictly contain a unique text body.
The lines that start with a + sign are the added lines
The lines that start with a - sign are deleted lines
The lines with a , are unmodified
Each modified line starts with a number which represents the line number in the actual file.`,
        ...fileDiffs,
    ]);
}

async function findSummaryComment(context) {
    const { data: issueComments } = await octokit.issues.listComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.payload.pull_request.number,
        per_page: 25,
    });
    return issueComments.findLast((issueComment) =>
        issueComment.body.startsWith("AI Review Summary")
    );
}
