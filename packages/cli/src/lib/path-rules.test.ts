import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { matchesPathRule, pathRuleCandidate } from "./path-rules";

const cwd = "/work/proj";

const candidate = (command: string, at = cwd) => pathRuleCandidate(command, at);

describe("pathRuleCandidate: what is offered", () => {
  test("names the program and the common parent of the targets, then each parent up to but excluding /", () => {
    expect(candidate("rm -rf /tmp/x/a /tmp/x/b")).toEqual({ program: "rm", dirs: ["/tmp/x", "/tmp"] });
    expect(candidate("rm /tmp/x/y/z.txt")).toEqual({ program: "rm", dirs: ["/tmp/x/y", "/tmp/x", "/tmp"] });
  });

  test("targets in different folders share their closest common parent", () => {
    expect(candidate("rm /tmp/x/a/f /tmp/x/b/g")?.dirs).toEqual(["/tmp/x", "/tmp"]);
    expect(candidate("rm /tmp/x/f /var/y/g")).toBeNull();
  });

  test("a trailing slash and repeated slashes do not change the directory", () => {
    expect(candidate("rm -r /tmp/x//a/")?.dirs).toEqual(["/tmp/x", "/tmp"]);
  });

  test("relative targets are resolved against the cwd", () => {
    expect(candidate("rm build/out.js")).toEqual({ program: "rm", dirs: ["/work/proj/build", "/work/proj", "/work"] });
    expect(candidate("rm ./a.txt")?.dirs).toEqual(["/work/proj", "/work"]);
  });

  test("covers rm, rmdir, unlink, mv, cp, mkdir and touch", () => {
    for (const program of ["rm", "rmdir", "unlink", "mv", "cp", "mkdir", "touch"]) {
      const command = program === "mv" || program === "cp" ? `${program} /tmp/x/a /tmp/x/b` : `${program} /tmp/x/a`;
      expect(candidate(command)?.program).toBe(program);
    }
  });

  test("options are not targets, and after -- everything is", () => {
    expect(candidate("rm -f -r -- /tmp/x/a")?.dirs[0]).toBe("/tmp/x");
    expect(candidate("rm -rf -- /tmp/x/-weird")?.dirs[0]).toBe("/tmp/x");
    expect(candidate("cp -a /tmp/x/a /tmp/x/b")?.dirs[0]).toBe("/tmp/x");
    expect(candidate("mkdir -p /tmp/x/a/b")?.dirs[0]).toBe("/tmp/x/a");
  });

  test("a glob is fine in the last segment only", () => {
    expect(candidate("rm /tmp/x/*.log")).toEqual({ program: "rm", dirs: ["/tmp/x", "/tmp"] });
    expect(candidate("rm -rf /tmp/x/cache-?")?.dirs[0]).toBe("/tmp/x");
    expect(candidate("rm /tmp/*/a.log")).toBeNull();
    expect(candidate("rm /tmp/x[12]/a.log")).toBeNull();
  });

  test("a glob that can match . or .. is not offered", () => {
    expect(candidate("rm -rf /tmp/x/.*")).toBeNull();
    expect(candidate("rm /tmp/x/.")).toBeNull();
    expect(candidate("rm /tmp/x/..")).toBeNull();
  });

  test("the same program in a chain is fine, any other segment is not", () => {
    expect(candidate("rm /tmp/x/a && rm /tmp/x/b")?.dirs).toEqual(["/tmp/x", "/tmp"]);
    expect(candidate("rm /tmp/x/a; rm /tmp/x/b || rm /tmp/x/c")?.dirs[0]).toBe("/tmp/x");
    expect(candidate("rm /tmp/x/a\nrm /tmp/x/b")?.dirs[0]).toBe("/tmp/x");
    expect(candidate("rm /tmp/x/a && ls")).toBeNull();
    expect(candidate("ls && rm /tmp/x/a")).toBeNull();
    expect(candidate("rm /tmp/x/a && mv /tmp/x/b /tmp/x/c")).toBeNull();
    expect(candidate("echo hi | rm /tmp/x/a")).toBeNull();
  });

  test("cd, wrappers, env assignments and nested shells are not offered", () => {
    expect(candidate("cd /tmp/x && rm a")).toBeNull();
    expect(candidate("sudo rm /tmp/x/a")).toBeNull();
    expect(candidate("doas rm /tmp/x/a")).toBeNull();
    expect(candidate("env rm /tmp/x/a")).toBeNull();
    expect(candidate("xargs rm /tmp/x/a")).toBeNull();
    expect(candidate("FOO=1 rm /tmp/x/a")).toBeNull();
    expect(candidate("bash -c 'rm /tmp/x/a'")).toBeNull();
    expect(candidate("eval rm /tmp/x/a")).toBeNull();
    expect(candidate("if true; then rm /tmp/x/a; fi")).toBeNull();
    expect(candidate("/bin/rm /tmp/x/a")).toBeNull();
  });

  test("variables, substitutions, tilde and braces are not literal", () => {
    expect(candidate("rm -rf $DIR")).toBeNull();
    expect(candidate("rm -rf /tmp/x/$NAME")).toBeNull();
    expect(candidate("rm -rf ${DIR}/a")).toBeNull();
    expect(candidate("rm -rf ~")).toBeNull();
    expect(candidate("rm ~/a.txt")).toBeNull();
    expect(candidate("rm $(ls /tmp/x)")).toBeNull();
    expect(candidate("rm `ls /tmp/x`")).toBeNull();
    expect(candidate('rm "$(ls /tmp/x)"')).toBeNull();
    expect(candidate("rm /tmp/x/{a,b}")).toBeNull();
  });

  test("redirects and heredocs are not offered", () => {
    expect(candidate("rm /tmp/x/a > /tmp/x/log")).toBeNull();
    expect(candidate("rm /tmp/x/a 2>/dev/null")).toBeNull();
    expect(candidate("rm /tmp/x/a &> /tmp/x/log")).toBeNull();
    expect(candidate("rm /tmp/x/a < input")).toBeNull();
  });

  test("a .. segment is never offered, however it resolves", () => {
    expect(candidate("rm /tmp/x/../y")).toBeNull();
    expect(candidate("rm ../a")).toBeNull();
    expect(candidate("rm a/../../b")).toBeNull();
  });

  test("no targets, an empty target or an unreadable command is not offered", () => {
    expect(candidate("rm")).toBeNull();
    expect(candidate("rm -rf")).toBeNull();
    expect(candidate('rm ""')).toBeNull();
    expect(candidate("rm '/tmp/x/a")).toBeNull();
    expect(candidate("")).toBeNull();
  });

  test("the root and the home directory are never a rule folder", () => {
    expect(candidate("rm /a.txt")).toBeNull();
    expect(candidate("rm -rf /tmp")).toBeNull();
    expect(candidate(`rm ${join(homedir(), "a.txt")}`)).toBeNull();
    expect(candidate(`rm -r ${join(homedir(), "projects", "x", "a")}`)?.dirs).toEqual([
      join(homedir(), "projects", "x"),
      join(homedir(), "projects"),
    ]);
  });

  test("catastrophic commands are never offered", () => {
    expect(candidate("rm -rf /")).toBeNull();
    expect(candidate("rm -rf /*")).toBeNull();
    expect(candidate("rm -rf /usr")).toBeNull();
    expect(candidate("rm -rf .")).toBeNull();
    expect(candidate("rm -rf * ")).toBeNull();
    expect(candidate("rm -rf /tmp/x/a /")).toBeNull();
    expect(candidate("rm -rf /tmp/x/a && rm -rf /")).toBeNull();
  });

  test("a .git folder is never a target", () => {
    expect(candidate("rm -rf /work/proj/.git")).toBeNull();
    expect(candidate("rm /work/proj/.git/index.lock")).toBeNull();
  });

  test("options that take a value are not guessed at", () => {
    expect(candidate("mv -t /tmp/x/dest /tmp/x/a")).toBeNull();
    expect(candidate("cp --target-directory=/tmp/x/dest /tmp/x/a")).toBeNull();
    expect(candidate("cp -rt /tmp/x/dest /tmp/x/a")).toBeNull();
    expect(candidate("mkdir -m 755 /tmp/x/a")).toBeNull();
    expect(candidate("touch -d yesterday /tmp/x/a")).toBeNull();
    expect(candidate("touch -r /etc/hosts /tmp/x/a")).toBeNull();
  });

  test("not a path program is not offered", () => {
    expect(candidate("ls /tmp/x")).toBeNull();
    expect(candidate("git rm /tmp/x/a")).toBeNull();
    expect(candidate("chmod 777 /tmp/x/a")).toBeNull();
  });

  test("find <dir> ... -delete is a path command; find without -delete or with -exec is not", () => {
    expect(candidate("find /tmp/x/cache -name '*.o' -delete")).toEqual({ program: "find", dirs: ["/tmp/x", "/tmp"] });
    expect(candidate("find /tmp/x/a /tmp/x/b -type f -mtime +3 -delete")?.dirs[0]).toBe("/tmp/x");
    expect(candidate("find build -name '*.map' -delete")?.dirs[0]).toBe("/work/proj");
    expect(candidate("find /tmp/x/cache -name '*.o'")).toBeNull();
    expect(candidate("find /tmp/x/cache -exec rm {} + -delete")).toBeNull();
    expect(candidate("find /tmp/x/cache -name x -execdir sh -c y ; -delete")).toBeNull();
    expect(candidate("find /tmp/x/cache -fprint /etc/out -delete")).toBeNull();
    expect(candidate("find -name '*.o' -delete")).toBeNull();
    expect(candidate("find . -name '*.o' -delete")).toBeNull();
    expect(candidate("find / -name '*.o' -delete")).toBeNull();
    expect(candidate("find $DIR -delete")).toBeNull();
    expect(candidate("find /tmp/x/cache -delete && rm /tmp/x/a")).toBeNull();
  });
});

describe("matchesPathRule: what a stored rule covers", () => {
  const rule = (dir: string, program = "rm") => ({ program, dir });
  const matches = (command: string, r: { program: string; dir: string }, at = cwd) => matchesPathRule(command, at, r);

  test("matches the same program with every target inside the folder", () => {
    expect(matches("rm -rf /tmp/x/a /tmp/x/b", rule("/tmp/x"))).toBe(true);
    expect(matches("rm /tmp/x/deep/er/file", rule("/tmp/x"))).toBe(true);
    expect(matches("rm /tmp/x/a && rm /tmp/x/b", rule("/tmp/x"))).toBe(true);
    expect(matches("rm /tmp/x/*.log", rule("/tmp/x"))).toBe(true);
    expect(matches("rm -rf /tmp/x/a", rule("/tmp"))).toBe(true);
  });

  test("a folder is not a match for its own sibling prefix, nor for the folder itself", () => {
    expect(matches("rm /tmp/ab/f", rule("/tmp/a"))).toBe(false);
    expect(matches("rm -rf /tmp/x", rule("/tmp/x"))).toBe(false);
    expect(matches("rm /tmp/x/a /tmp/y/b", rule("/tmp/x"))).toBe(false);
  });

  test("a trailing slash on the rule folder is harmless", () => {
    expect(matches("rm /tmp/x/a", rule("/tmp/x/"))).toBe(true);
    expect(matches("rm /tmp/xy/a", rule("/tmp/x/"))).toBe(false);
  });

  test("relative targets resolve against the cwd", () => {
    expect(matches("rm build/a.js", rule("/work/proj"))).toBe(true);
    expect(matches("rm build/a.js", rule("/work/proj"), "/other")).toBe(false);
    expect(matches("rm build/a.js", rule("/work/proj/build"))).toBe(true);
    expect(matches("rm src/a.js", rule("/work/proj/build"))).toBe(false);
  });

  test("another program does not match", () => {
    expect(matches("mv /tmp/x/a /tmp/x/b", rule("/tmp/x"))).toBe(false);
    expect(matches("rm /tmp/x/a", rule("/tmp/x", "mv"))).toBe(false);
    expect(matches("rm /tmp/x/a", rule("/tmp/x", "find"))).toBe(false);
    expect(matches("rm /tmp/x/a", rule("/tmp/x", "ls"))).toBe(false);
  });

  test("a chain only matches when every command is the program", () => {
    expect(matches("rm /tmp/x/a && ls", rule("/tmp/x"))).toBe(false);
    expect(matches("rm /tmp/x/a; mv /tmp/x/a /tmp/x/b", rule("/tmp/x"))).toBe(false);
    expect(matches("cd /tmp/x && rm a", rule("/tmp/x"))).toBe(false);
  });

  test("sudo, doas, variables, tilde, .. and substitutions never match", () => {
    expect(matches("sudo rm /tmp/x/a", rule("/tmp/x"))).toBe(false);
    expect(matches("doas rm /tmp/x/a", rule("/tmp/x"))).toBe(false);
    expect(matches("rm -rf $DIR", rule("/tmp/x"))).toBe(false);
    expect(matches("rm -rf /tmp/x/$DIR", rule("/tmp/x"))).toBe(false);
    expect(matches("rm -rf ~/a", rule(homedir()))).toBe(false);
    expect(matches("rm /tmp/x/../y", rule("/tmp/x"))).toBe(false);
    expect(matches("rm /tmp/x/a/../../y", rule("/tmp/x"))).toBe(false);
    expect(matches("rm $(echo /tmp/x/a)", rule("/tmp/x"))).toBe(false);
    expect(matches("rm /tmp/x/a > /tmp/x/log", rule("/tmp/x"))).toBe(false);
  });

  test("catastrophic commands never match, whatever the rule", () => {
    expect(matches("rm -rf /", rule("/"))).toBe(false);
    expect(matches("rm -rf /tmp/x/a /", rule("/tmp/x"))).toBe(false);
    expect(matches("rm -rf /tmp/x/a && rm -rf /*", rule("/tmp/x"))).toBe(false);
    expect(matches("rm -rf /usr/a", rule("/usr"))).toBe(true);
    expect(matches("rm -rf /usr", rule("/"))).toBe(false);
  });

  test("a rule on / or on the home directory (or above it) matches nothing", () => {
    expect(matches("rm /tmp/x/a", rule("/"))).toBe(false);
    expect(matches(`rm ${join(homedir(), "a")}`, rule(homedir()))).toBe(false);
    expect(matches(`rm ${join(homedir(), "p", "a")}`, rule(join(homedir(), ".."))) ).toBe(false);
    expect(matches(`rm ${join(homedir(), "p", "a")}`, rule(join(homedir(), "p")))).toBe(true);
  });

  test("a .git target never matches", () => {
    expect(matches("rm -rf /work/proj/.git", rule("/work/proj"))).toBe(false);
    expect(matches("rm /work/proj/.git/index.lock", rule("/work/proj"))).toBe(false);
  });

  test("find ... -delete matches a rule with the find program", () => {
    expect(matches("find /tmp/x/cache -name '*.o' -delete", rule("/tmp/x", "find"))).toBe(true);
    expect(matches("find /tmp/x/cache -name '*.o' -delete", rule("/tmp/x", "rm"))).toBe(false);
    expect(matches("find /tmp/y/cache -delete", rule("/tmp/x", "find"))).toBe(false);
    expect(matches("find /tmp/x/cache -exec rm {} ;", rule("/tmp/x", "find"))).toBe(false);
  });

  test("a rule folder with .. segments is resolved before comparing", () => {
    expect(matches("rm /tmp/x/a", rule("/tmp/x/sub/.."))).toBe(true);
    expect(matches("rm /tmp/y/a", rule("/tmp/x/../y"))).toBe(true);
    expect(matches("rm /tmp/x/a", rule("/tmp/x/../y"))).toBe(false);
  });
});
