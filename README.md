# pi-vim

Vim mode for [pi](https://github.com/badlogic/pi-mono).

## Install

```bash
pi install git:github.com/leohenon/pi-vim
```

## Usage

Toggle with:

```text
/vim-mode
```

## Insert mode

- `Esc` / `Ctrl-[` → normal mode
- `Shift+Alt+A` → line end
- `Shift+Alt+I` → line start
- `Alt+o` → open line below
- `Alt+Shift+O` → open line above

## Normal mode

### Mode

- `i`, `a`, `I`, `A`
- `o`, `O`
- `v` → visual
- `V` → visual line

### Motions

- `h`, `j`, `k`, `l`
- `w`, `b`, `e`
- `W`, `B`, `E`
- `0`, `^`, `_`, `$`
- `gg`, `G`
- `{`, `}`
- `f`, `F`, `t`, `T`
- `;`, `,`
- counts on motions

### Delete

- `dd`, `dw`, `de`, `db`, `dW`, `dE`, `dB`
- `d0`, `d^`, `d$`, `d_`, `dG`
- `d{count}j`, `d{count}k`
- `df`, `dF`, `dt`, `dT`
- `diw`, `daw`, `di"`, `da"`, `di'`, `da'`, ``di` ``, ``da` ``, `di(`, `da(`, `di[`, `da[`, `di{`, `da{`

### Change

- `cc`, `cw`, `ce`, `cb`, `cW`, `cE`, `cB`
- `c0`, `c^`, `c$`, `c_`
- `cf`, `cF`, `ct`, `cT`
- `ciw`, `caw`, `ci"`, `ca"`, `ci'`, `ca'`, ``ci` ``, ``ca` ``, `ci(`, `ca(`, `ci[`, `ca[`, `ci{`, `ca{`

### Yank

- `yy`, `Y`
- `yw`, `ye`, `yb`, `yW`, `yE`, `yB`
- `y0`, `y^`, `y$`, `y_`, `yG`
- `y{count}j`, `y{count}k`
- `yf`
- `yiw`, `yaw`, `yi"`, `ya"`, `yi'`, `ya'`, ``yi` ``, ``ya` ``, `yi(`, `ya(`, `yi[`, `ya[`, `yi{`, `ya{`

### Edit

- `x`, `s`, `S`
- `r{char}`
- `D`, `C`
- counts on `x`, `r`

### Put

- `p`, `P`
- counts on `p`, `P`

### Undo

- `u`, `Ctrl-_`
- `Ctrl-r`
- counts on undo/redo

## Visual mode

### Characterwise

- `v` enters visual mode
- `Esc` exits to normal mode
- `d` / `x` delete selection
- `y` yank selection
- `c` change selection
- `p`, `P` replace selection with unnamed register

### Linewise

- `V` enters visual line mode
- `j`, `k` extend by full lines
- `Esc` exits to normal mode
- `d` / `x` delete selected lines
- `y` yank selected lines
- `c` change selected lines
- `p`, `P` replace selected lines

## Files

```text
pi-vim/
  index.ts
  package.json
  README.md
```
