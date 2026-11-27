# >>> install-conf reader (the same in every root script; a test checks the copies match)
# Strict: one KEY=value per line, known keys only, no duplicates, values ^[A-Za-z0-9_./-]{1,200}$, user/group names
# ^[a-z_][a-z0-9_-]{0,31}$, paths absolute without a `..` segment. Parsed, never sourced. Sets IC_<KEY>.
read_install_conf() {
  local f=$1 line k v n=0 seen=' '
  [[ -f $f && ! -L $f ]] || { echo "install.conf: $f is missing (run scripts/install.sh)" >&2; return 1; }
  while IFS= read -r line || [[ -n $line ]]; do
    n=$((n + 1))
    [[ -z $line ]] && continue
    [[ $line =~ ^([A-Z_]+)=(.*)$ ]] || { echo "install.conf line $n: not KEY=value" >&2; return 1; }
    k=${BASH_REMATCH[1]} v=${BASH_REMATCH[2]}
    case $k in OPERATOR | OPERATOR_GROUP | DAEMON_USER | RUNNER_USER | OPT_DIR | STATE_DIR | ETC_DIR | TOOLS_DIR) ;; *) echo "install.conf line $n: unknown key $k" >&2; return 1 ;; esac
    [[ $seen == *" $k "* ]] && { echo "install.conf line $n: $k given twice" >&2; return 1; }
    seen+="$k "
    [[ $v =~ ^[A-Za-z0-9_./-]{1,200}$ ]] || { echo "install.conf: $k has a bad value" >&2; return 1; }
    case $k in
      OPERATOR | OPERATOR_GROUP | DAEMON_USER | RUNNER_USER) [[ $v =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "install.conf: $k is not a user or group name" >&2; return 1; } ;;
      *) [[ $v == /* && /$v/ != */../* ]] || { echo "install.conf: $k must be an absolute path" >&2; return 1; } ;;
    esac
    printf -v "IC_$k" '%s' "$v"
  done <"$f"
  for k in OPERATOR OPERATOR_GROUP DAEMON_USER RUNNER_USER OPT_DIR STATE_DIR ETC_DIR TOOLS_DIR; do
    [[ $seen == *" $k "* ]] || { echo "install.conf: $k is missing" >&2; return 1; }
  done
}
# <<< install-conf reader
