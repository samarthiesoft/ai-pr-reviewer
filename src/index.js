const { Octokit } = require("@octokit/rest");
const { GoogleGenerativeAI, SchemaType, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const { context } = require("@actions/github");
const { info, warning } = require("@actions/core");
const shell = require("shelljs");
const fs = require("fs");
// shell.config.silent = true;

const pullRequest = context.payload.pull_request;
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

    const comments = await getExistingComments(context);

    const summaryComment = comments.findLast((issueComment) => issueComment.body.startsWith("AI Review Summary"));

    // Find the base and head commits for the review
    let baseCommitHash = pullRequest.base.sha;
    if (summaryComment) {
        const matches = summaryComment.body.match(/\[Last reviewed commit: (.*)\]/);
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

    info(`Diff for summary (PR base..Latest): ${pullRequest.base.sha}..${headCommitHash}`);
    const prDiff = getDiffBetweenCommits(pullRequest.base.sha, headCommitHash);

    info(`Diff for suggestions (Last reviewed..Latest): ${baseCommitHash}..${headCommitHash}`);
    const ignoreFiles = getIgnoreFiles();
    ignoreFiles.push(".reviewignore");
    info(`Ignoring files in .reviewignore:\n${ignoreFiles.toString()}`);
    const fileDiffs = getFileDiffsWithLineNumbers(baseCommitHash, headCommitHash, ignoreFiles);

    let additionalContext;
    if (fs.existsSync(`${process.env.GITHUB_WORKSPACE}/.github/.reviewcontext`)) {
        additionalContext = fs.readFileSync(`${process.env.GITHUB_WORKSPACE}/.github/.reviewcontext`, { encoding: "utf-8" }).toString();
        info(`Additional context found:\n${additionalContext}`);
    } else {
        info("Additional context not found. Skipping");
    }

    info(`Gemini response - Summary:\n`);
    let summary = "";
    const summaryStream = await getSummaryStream(prDiff, additionalContext);
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
    const suggestionsStream = await getSuggestionsStream(fileDiffs, additionalContext, comments);
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
            issue_number: pullRequest.number,
            body: summary,
        });
    }

    // Add line-by-line comments
    for (const comment of suggestions) {
        let requestData = {
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: pullRequest.number,
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
    do {
        commits = await octokit.pulls.listCommits({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: pullRequest.number,
            per_page: 100,
            page,
        });

        allCommits.push(...commits.data.map((commit) => commit.sha));
        page++;
    } while (commits.data.length > 0);

    return allCommits;
}

function getDiffBetweenCommits(baseCommitHash, headCommitHash) {
    return shell.exec(`cd ${process.env.GIT_REPO_PATH} && git diff ${baseCommitHash}..${headCommitHash}`).stdout;
}

function getFileDiffsWithLineNumbers(baseCommitHash, headCommitHash, ignoreFiles) {
    const fileNames = shell
        .exec(`cd ${process.env.GIT_REPO_PATH} && git diff --name-only ${baseCommitHash}..${headCommitHash}`)
        .stdout.trim()
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => !ignoreFiles.includes(f));

    return fileNames.map(
        (fileName) =>
            shell.exec(
                `cd ${process.env.GIT_REPO_PATH} && git diff ${baseCommitHash}..${headCommitHash} -- ${fileName} | gawk '
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
            ).stdout
    );
}

async function getSummaryStream(diff, additionalContext) {
    const prompt = [
        `Here is a diff for a pull request in a project. 
Review the code and create a summary that includes a high level overview of all the changes made in the PR.
The lines that start with a + sign are the added lines
The lines that start with a - sign are deleted lines
The lines with a , are unmodified`,
    ];
    if (additionalContext) {
        prompt.push(additionalContext);
    }
    prompt.push(diff);

    return await summaryModel.generateContentStream(prompt);
}

async function getSuggestionsStream(fileDiffs, additionalContext, existingComments) {
    const prompt = [
        `You are given individual file diffs for a pull request in a project. Review the code diff and provide detailed critical suggestions for improving code maintainability, reducing potential errors, and identifying bugs. Your response should include the following:

Line Reference: Mention the exact from_line, to_line, and filename where your suggestion applies.
Side Reference: Specify the side of the diff. Use LEFT for deletions and RIGHT for additions.
Unique Suggestions: Ensure each suggestion is unique and relevant to the corresponding code. Strictly avoid repeating any suggestions.
Code Examples: For suggestions that involve code changes, provide concrete examples showing how to improve the code.
Limit Suggestions: Provide a maximum of 10 suggestions.

Diff Conventions:
Lines starting with + represent additions.
Lines starting with - represent deletions.
Lines with , represent unmodified content.
Each line is prefixed with a line number representing its position in the actual file.

Regarding diffs which only have deletions: Try not to comment on those. Only add a review for it if the funtionality might be hampered due to that deletion. 
`,
    ];
    if (additionalContext) {
        prompt.push(additionalContext);
    }
    if (existingComments.length) {
        info(`We have found ${existingComments.length} existing comments`)
        prompt.push(`Since this an updated pull request, you are also being provided the previous comments as well so that you know the current status of the pull request ${JSON.stringify(existingComments)} 
        
        
        Below are the diffs that are present in the pull request: 
        `)
    }
    
    return await suggestionsModel.generateContentStream([...prompt, ...fileDiffs]);
}

async function getExistingComments(context) {
    const { data: issueComments } = await octokit.issues.listComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: pullRequest.number,
        per_page: 25,
    });
    // return issueComments.findLast((issueComment) => issueComment.body.startsWith("AI Review Summary"));
    return issueComments;
}

function getIgnoreFiles() {
    return fs
        .readFileSync(`${process.env.GITHUB_WORKSPACE}/.reviewignore`, { encoding: "utf-8" })
        .trim()
        .split("\n")
        .map((f) => f.trim());
}
