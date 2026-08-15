#!/bin/sh
set -eu
exec /usr/bin/python3 -I -c 'import os, sys; os.environ["HERMES_DEV"]="1"; from hermes_cli.main import main; os.environ["HERMES_DEV"]="1"; sys.argv[0]="hermes"; raise SystemExit(main())' "$@"
