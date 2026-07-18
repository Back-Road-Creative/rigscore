# Homebrew formula for rigscore.
#
# Tap + install:
#   brew tap Back-Road-Creative/rigscore https://github.com/Back-Road-Creative/rigscore
#   brew install rigscore
#
# Homebrew is a distribution channel beyond `npx github:` / npm — it reaches the
# large population of developers and security engineers who manage their CLI
# tooling with brew. The formula installs from the released source tarball and
# depends on Node (rigscore is a pure-JS CLI with no native addons).
#
# For a fully self-contained, no-Node download, see the archives attached to each
# GitHub release by .github/workflows/prebuilt-binaries.yml.
class Rigscore < Formula
  desc "Configuration hygiene checker for AI dev environments"
  homepage "https://github.com/Back-Road-Creative/rigscore"
  url "https://github.com/Back-Road-Creative/rigscore/archive/refs/tags/v2.1.0.tar.gz"
  sha256 "750015357fe6b59137cceddb52b80bb08a971983318d4bc61e84b16bc0cad450"
  license "MIT"
  head "https://github.com/Back-Road-Creative/rigscore.git", branch: "main"

  depends_on "node"

  def install
    # Install the package (and its deps) under libexec, then link the CLI.
    # `--ignore-scripts` skips the repo's `prepare` (husky) hook, which is a
    # dev-only convenience and must not run inside the Homebrew sandbox.
    system "npm", "install", *std_npm_args, "--ignore-scripts"
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/rigscore --version")
  end
end
