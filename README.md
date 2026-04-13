# pi-vim

A Vim-mode editor extension for [pi](https://github.com/badlogic/pi-mono).

## Install

```bash
pi install git:github.com/leohenon/pi-vim
```

## Usage

Toggle with:

```text
/vim-mode
```

## Keybindings

### Insert mode

- `Esc` → normal mode

### Normal mode

- `i` → insert
- `a`, `A`, `I`
- `h`, `j`, `k`, `l`
- `w`, `b`, `e`
- `W`, `B`, `E`
- `0`, `^`, `_`, `$`
- `gg`, `G`
- `{`, `}`
- `o`, `O`
- `x`, `s`, `r`, `D`, `C`, `J`, `S`
- counts for `x`, `r`, `p`, `P`, motions, undo, redo
- `dd`, `dw`, `de`, `db`, `dW`, `dE`, `dB`
- `cc`, `cw`, `ce`, `cb`, `cW`, `cE`, `cB`
- `yy`, `yw`, `ye`, `yb`, `yW`, `yE`, `yB`
- `yy`, `Y`, `p`, `P`
- `f`, `F`, `t`, `T`, `;`, `,`
- `u` → undo
- `Ctrl-r` → redo

App-level pi keybindings still work through `CustomEditor`.

## Files

```text
pi-vim/
  index.ts
  package.json
  README.md
```
