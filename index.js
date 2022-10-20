const { spawn } = require('child_process');
const { existsSync, writeFileSync } = require('fs');
const { EOL } = require('os');
const path = require('path');
const semverInc = require('semver/functions/inc')

// Change working directory if user defined APPSETTINGSJSON_DIR
if (process.env.PACKAGEJSON_DIR) {
  process.env.GITHUB_WORKSPACE = `${process.env.GITHUB_WORKSPACE}/${process.env.PACKAGEJSON_DIR}`;
  process.chdir(process.env.GITHUB_WORKSPACE);
}

const workspace = process.env.GITHUB_WORKSPACE;
const appsettingsObject = getAppsettingsJson();

(async () => {
  const event = process.env.GITHUB_EVENT_PATH ? require(process.env.GITHUB_EVENT_PATH) : {};

  if (!event.commits && !process.env['INPUT_VERSION-TYPE']) {
    console.log("Couldn't find any commits in this event, incrementing patch version...");
  }

  const allowedTypes = ['major', 'minor', 'patch', 'rc']
  if (process.env['INPUT_VERSION-TYPE'] && !allowedTypes.includes(process.env['INPUT_VERSION-TYPE'])) {
    exitFailure('Invalid version type');
    return;
  }

  let versionType = process.env['INPUT_VERSION-TYPE'];
  const tagPrefix = process.env['INPUT_TAG-PREFIX'] || '';
  console.log('tagPrefix:', tagPrefix);
  const messages = event.commits ? event.commits.map((commit) => commit.message + '\n' + commit.body) : [];

  const commitMessage = process.env['INPUT_COMMIT-MESSAGE'] || 'ci: version bump to {{version}}';
  console.log('commit messages:', messages);

  const bumpPolicy = process.env['INPUT_BUMP-POLICY'] || 'all';
  const commitMessageRegex = new RegExp(commitMessage.replace(/{{version}}/g, `${tagPrefix}\\d+\\.\\d+\\.\\d+`), 'ig');

  let isVersionBump = false;

  if (bumpPolicy === 'all') {
    isVersionBump = messages.find((message) => commitMessageRegex.test(message)) !== undefined;
  } else if (bumpPolicy === 'last-commit') {
    isVersionBump = messages.length > 0 && commitMessageRegex.test(messages[messages.length - 1]);
  } else if (bumpPolicy === 'ignore') {
    console.log('Ignoring any version bumps in commits...');
  } else {
    console.warn(`Unknown bump policy: ${bumpPolicy}`);
  }

  if (isVersionBump) {
    exitSuccess('No action necessary because we found a previous bump!');
    return;
  }

  // input wordings for MAJOR, MINOR, PATCH, PRE-RELEASE
  const majorWords = process.env['INPUT_MAJOR-WORDING'].split(',');
  const minorWords = process.env['INPUT_MINOR-WORDING'].split(',');
  // patch is by default empty, and '' would always be true in the includes(''), thats why we handle it separately
  const patchWords = process.env['INPUT_PATCH-WORDING'] ? process.env['INPUT_PATCH-WORDING'].split(',') : null;
  const preReleaseWords = process.env['INPUT_RC-WORDING'] ? process.env['INPUT_RC-WORDING'].split(',') : null;

  console.log('config words:', { majorWords, minorWords, patchWords, preReleaseWords });

  // get default version bump
  let foundWord = null;
  // get the pre-release prefix specified in action
  let preid = process.env.INPUT_PREID;

  // case if version-type not found
  if (!versionType) {
    // case: if wording for MAJOR found
    if (
      messages.some(
        (message) => /^([a-zA-Z]+)(\(.+\))?(\!)\:/.test(message) || majorWords.some((word) => message.includes(word)),
      )
    ) {
      versionType = 'major';
    }
    // case: if wording for MINOR found
    else if (messages.some((message) => minorWords.some((word) => message.includes(word)))) {
      versionType = 'minor';
    }
    // case: if wording for PATCH found
    else if (patchWords && messages.some((message) => patchWords.some((word) => message.includes(word)))) {
      versionType = 'patch';
    }
    // case: if wording for PRE-RELEASE found
    else if (
      preReleaseWords &&
      messages.some((message) =>
        preReleaseWords.some((word) => {
          if (message.includes(word)) {
            foundWord = word;
            return true;
          } else {
            return false;
          }
        }),
      )
    ) {
      if (foundWord !== ''){
        preid = foundWord.split('-')[1];
      }
      versionType = 'prerelease';
    }
    // case: if no wording found
    else {
      versionType = process.env.INPUT_DEFAULT;
    }
  }

  console.log('version action after first waterfall:', versionType);

  // case: if default=prerelease,
  // rc-wording is also set
  // and does not include any of rc-wording
  // then unset it and do not run
  if (
    versionType === 'prerelease' &&
    preReleaseWords &&
    !messages.some((message) => preReleaseWords.some((word) => message.includes(word)))
  ) {
    versionType = null;
  }

  // case: if default=prerelease, but rc-wording is NOT set
  if (versionType === 'prerelease' && preid) {
    versionType = 'prerelease';
    versionType = `${versionType} --preid=${preid}`;
  }

  console.log('version action after final decision:', versionType);

  // case: if nothing of the above matches
  if (!versionType) {
    exitSuccess('No version keywords found, skipping bump.');
    return;
  }

  // case: if user sets push to false, to skip pushing new tag/appsettings.json
  const push = process.env['INPUT_PUSH'];
  if (push === 'false' || push === false) {
    exitSuccess('User requested to skip pushing new tag and package.json. Finished.');
    return;
  }

  // GIT logic
  try {
    const versionBeforeBump = appsettingsObject.ApplicationVersion.toString();
    // set git user
    await runInWorkspace('git', ['config', 'user.name', `"${process.env.GITHUB_USER || 'Automated Version Bump'}"`]);
    await runInWorkspace('git', [
      'config',
      'user.email',
      `"${process.env.GITHUB_EMAIL || 'gh-action-bump-version@users.noreply.github.com'}"`,
    ]);

    let currentBranch;
    let isPullRequest = false;
    if (process.env.GITHUB_HEAD_REF) {
      // Comes from a pull request
      currentBranch = process.env.GITHUB_HEAD_REF;
      isPullRequest = true;
    } else {
      currentBranch = /refs\/[a-zA-Z]+\/(.*)/.exec(process.env.GITHUB_REF)[1];
    }
    if (process.env['INPUT_TARGET-BRANCH']) {
      // We want to override the branch that we are pulling / pushing to
      currentBranch = process.env['INPUT_TARGET-BRANCH'];
    }
    console.log('currentBranch:', currentBranch);

    if (!currentBranch) {
      exitFailure('No branch found');
      return;
    }

    // do it in the current checked out github branch (DETACHED HEAD)
    let newVersion = semverInc(versionBeforeBump, versionType);
    console.log('old Version:', versionBeforeBump, '/', 'version type:', versionType);
    console.log('new Version:', newVersion);
    newVersion = `${tagPrefix}${newVersion}`;
    // change appsettings.json file
    appsettingsObject.ApplicationVersion = newVersion;
    await writeFileSync(path.join(workspace, 'src', 'appsettings.json'), JSON.stringify(appsettingsObject));
    if (process.env['INPUT_SKIP-COMMIT'] !== 'true') {
      await runInWorkspace('git', ['commit', '-a', '-m', commitMessage.replace(/{{version}}/g, newVersion)]);
    }

    // now go to the actual branch to perform the same versioning
    if (isPullRequest) {
      // First fetch to get updated local version of branch
      await runInWorkspace('git', ['fetch']);
    }
    await runInWorkspace('git', ['checkout', currentBranch]);
    newVersion = `${tagPrefix}${newVersion}`;
    console.log(`newVersion after merging tagPrefix+newVersion: ${newVersion}`);
    console.log(`::set-output name=newTag::${newVersion}`);

    const remoteRepo = `https://${process.env.GITHUB_ACTOR}:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`;
    if (process.env['INPUT_SKIP-TAG'] !== 'true') {
      await runInWorkspace('git', ['tag', newVersion]);
      if (process.env['INPUT_SKIP-PUSH'] !== 'true') {
        await runInWorkspace('git', ['push', remoteRepo, '--follow-tags']);
        await runInWorkspace('git', ['push', remoteRepo, '--tags']);
      }
    } else {
      if (process.env['INPUT_SKIP-PUSH'] !== 'true') {
        await runInWorkspace('git', ['push', remoteRepo]);
      }
    }
  } catch (e) {
    logError(e);
    exitFailure('Failed to bump version');
    return;
  }
  exitSuccess('Version bumped!');
})();

function getAppsettingsJson() {
  const pathToPackage = path.join(workspace, 'src', 'appsettings.json');
  if (!existsSync(pathToPackage)) throw new Error("appsettings.json could not be found in your project's root.");
  return require(pathToPackage);
}

function exitSuccess(message) {
  console.info(`✔  success   ${message}`);
  process.exit(0);
}

function exitFailure(message) {
  logError(message);
  process.exit(1);
}

function logError(error) {
  console.error(`✖  fatal     ${error.stack || error}`);
}


function runInWorkspace(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: workspace });
    let isDone = false;
    const errorMessages = [];
    child.on('error', (error) => {
      if (!isDone) {
        isDone = true;
        reject(error);
      }
    });
    child.stderr.on('data', (chunk) => errorMessages.push(chunk));
    child.on('exit', (code) => {
      if (!isDone) {
        if (code === 0) {
          resolve();
        } else {
          reject(`${errorMessages.join('')}${EOL}${command} exited with code ${code}`);
        }
      }
    });
  });
}
