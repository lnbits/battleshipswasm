const client = window.createLNbitsExtensionClient({
  extensionId: 'battleshipswasm'
})
const MIN_JOIN_SATS = 20

const app = Vue.createApp({
  data() {
    return {
      loading: false,
      saving: false,
      creating: false,
      authorizingPayments: false,
      deletingGameId: '',
      settings: {
        enabled: false,
        haircut: 0,
        walletId: ''
      },
      gameForm: {
        name: 'Paid Battleships game',
        joinAmount: 100
      },
      wallets: [],
      games: [],
      pagination: {
        sortBy: 'createdAt',
        descending: true,
        page: 1,
        rowsPerPage: 10,
        rowsNumber: 0
      },
      search: '',
      columns: [
        {name: 'name', label: 'Game', field: 'name', align: 'left', sortable: true},
        {name: 'joinAmount', label: 'Join sats', field: 'joinAmount', align: 'right', sortable: true},
        {name: 'players', label: 'Players', field: 'playersCount', align: 'left', sortable: false},
        {name: 'status', label: 'Status', field: 'status', align: 'left', sortable: true},
        {name: 'winner', label: 'Winner', field: 'winnerLnAddress', align: 'left', sortable: false},
        {name: 'actions', label: '', field: 'id', align: 'right', sortable: false}
      ]
    }
  },

  computed: {
    selectedWalletName() {
      return this.wallets.find(wallet => wallet.id === this.effectiveWalletId)?.name || ''
    },

    canSave() {
      return !this.settings.enabled || !!this.effectiveWalletId
    },

    canCreate() {
      return (
        this.settings.enabled &&
        this.effectiveWalletId &&
        this.gameForm.name &&
        Number.isSafeInteger(Number(this.gameForm.joinAmount)) &&
        Number(this.gameForm.joinAmount) >= MIN_JOIN_SATS
      )
    },

    canAuthorizePayments() {
      return this.settings.enabled && !!this.effectiveWalletId
    },

    effectiveWalletId() {
      return this.settings.walletId || this.wallets[0]?.id || ''
    }
  },

  async mounted() {
    this.loading = true
    try {
      await Promise.all([this.fetchWallets(), this.fetchSettings(), this.fetchGames()])
    } finally {
      this.loading = false
    }
  },

  methods: {
    async fetchWallets() {
      try {
        const response = await client.listWallets()
        this.wallets = response.wallets || []
      } catch (error) {
        this.showError(error)
      }
    },

    async fetchSettings() {
      try {
        const response = await client.getSettings()
        this.settings = {...this.settings, ...(response.settings || {})}
        if (!this.settings.walletId && this.wallets.length) {
          this.settings.walletId = this.wallets[0].id
        }
      } catch (error) {
        this.showError(error)
      }
    },

    async saveSettings() {
      if (!this.canSave) return
      this.saving = true
      try {
        const response = await client.saveSettings({
          enabled: this.settings.enabled,
          walletId: this.effectiveWalletId,
          haircut: Number(this.settings.haircut),
          walletName: this.selectedWalletName
        })
        this.settings = response.settings
        this.notify('Battleships settings saved.', 'positive')
      } catch (error) {
        this.showError(error)
      } finally {
        this.saving = false
      }
    },

    async createGame() {
      if (!this.canCreate) return
      this.creating = true
      try {
        await this.ensureBackgroundPaymentGrant()
        await client.createGame({
          name: this.gameForm.name,
          joinAmount: Number(this.gameForm.joinAmount)
        })
        this.notify('Battleships game created.', 'positive')
        await this.fetchGames()
      } catch (error) {
        this.showError(error)
      } finally {
        this.creating = false
      }
    },

    backgroundPaymentGrant() {
      const joinAmount = Math.floor(Number(this.gameForm.joinAmount))
      return {
        walletId: this.effectiveWalletId,
        maxAmount: joinAmount * 2,
        destinationPolicy: 'external_allowed'
      }
    },

    async ensureBackgroundPaymentGrant(options = {}) {
      return await client.requestBackgroundPaymentPermission(
        this.backgroundPaymentGrant(),
        options
      )
    },

    paymentAuthorizationGrant() {
      return {
        walletId: this.effectiveWalletId,
        maxAmount: 1,
        destinationPolicy: 'own_wallets_only'
      }
    },

    async authorizePayments() {
      if (!this.canAuthorizePayments || this.authorizingPayments) return
      this.authorizingPayments = true
      try {
        const permission = await client.requestBackgroundPaymentPermission(
          this.paymentAuthorizationGrant(),
          {forcePrompt: true}
        )
        const savedMax = Number(permission?.grant?.max_amount || 0)
        this.notify(
          savedMax
            ? `Payment permission saved at ${savedMax} sats.`
            : 'Payment permission saved.',
          'positive'
        )
      } catch (error) {
        this.showError(error)
      } finally {
        this.authorizingPayments = false
      }
    },

    async fetchGames(props = {}) {
      const pagination = props.pagination || this.pagination
      try {
        const response = await client.listGames({
          page: pagination.page,
          rowsPerPage: pagination.rowsPerPage,
          sortBy: pagination.sortBy,
          descending: pagination.descending,
          search: this.search
        })
        this.games = response.games || []
        this.pagination = {...pagination, rowsNumber: response.total || 0}
      } catch (error) {
        this.showError(error)
      }
    },

    publicUrl(game) {
      return new URL(
        `/ext/battleshipswasm/games/${encodeURIComponent(game.id)}`,
        window.location.href
      ).href
    },

    async copyGame(game) {
      await navigator.clipboard?.writeText(this.publicUrl(game)).then(() => {
        this.notify('Game link copied.', 'positive')
      }).catch(error => {
        console.warn('[battleships admin] failed to copy game link', error)
      })
    },

    async settleGame(game) {
      try {
        await client.settleGame(game.id)
        this.notify('Winner payout sent.', 'positive')
        await this.fetchGames()
      } catch (error) {
        this.showError(error)
      }
    },

    async deleteGame(game) {
      if (game.status === 'completed' && game.payoutPending) {
        this.notify('Settle the pending payout before deleting this game.', 'warning')
        return
      }
      const confirmed = await this.confirmAction({
        title: 'Delete Game',
        message: `Delete "${game.name}"? This removes the game, players, fleets, and shots.`,
        okLabel: 'Delete',
        okColor: 'negative'
      })
      if (!confirmed) return
      this.deletingGameId = game.id
      try {
        await client.deleteGame(game.id)
        this.notify('Battleships game deleted.', 'positive')
        await this.fetchGames()
      } catch (error) {
        this.showError(error)
      } finally {
        this.deletingGameId = ''
      }
    },

    confirmAction({title, message, okLabel = 'OK', okColor = 'primary'}) {
      return new Promise(resolve => {
        Quasar.Dialog.create({
          dark: true,
          title,
          message,
          cancel: true,
          persistent: true,
          ok: {
            label: okLabel,
            color: okColor
          }
        })
          .onOk(() => resolve(true))
          .onCancel(() => resolve(false))
          .onDismiss(() => resolve(false))
      })
    },

    statusLabel(game) {
      if (game.status === 'completed' && game.payoutPending) return 'Payout pending'
      if (game.status === 'completed') return 'Complete'
      if (game.status === 'active') return 'Active'
      if (game.status === 'placing') return 'Placing fleets'
      return 'Waiting'
    },

    notify(message, type = 'info') {
      Quasar.Notify.create({type, message})
    },

    showError(error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[battleships admin]', message, error)
      Quasar.Notify.create({type: 'negative', message})
    }
  },

  render() {
    const h = Vue.h
    const component = name => Vue.resolveComponent(name)
    const QBadge = component('q-badge')
    const QBtn = component('q-btn')
    const QCard = component('q-card')
    const QInput = component('q-input')
    const QLayout = component('q-layout')
    const QSelect = component('q-select')
    const QTable = component('q-table')
    const QTd = component('q-td')
    const QToggle = component('q-toggle')
    const QTooltip = component('q-tooltip')

    const settingsInput = (field, props = {}) =>
      h(QInput, {
        modelValue: this.settings[field],
        'onUpdate:modelValue': value => {
          this.settings[field] = Number(value)
        },
        filled: true,
        dense: true,
        dark: true,
        ...props
      })

    const gameInput = (field, props = {}, parse = value => value) =>
      h(QInput, {
        modelValue: this.gameForm[field],
        'onUpdate:modelValue': value => {
          this.gameForm[field] = parse(value)
        },
        filled: true,
        dense: true,
        dark: true,
        ...props
      })

    return h(QLayout, {view: 'hHh lpR fFf', class: 'shell q-pa-md'}, () => [
      h('div', {class: 'row items-center q-mb-md q-gutter-sm'}, [
        h('div', {class: 'battleships-mark', 'aria-hidden': 'true'}, '🚢'),
        h('div', [
          h('h1', {class: 'text-h4 text-weight-bold q-my-none'}, 'Battleships'),
          h('p', {class: 'text-subtitle2 text-grey-5 q-my-none'}, 'Paid public Battleships games.')
        ])
      ]),

      h('div', {class: 'row q-col-gutter-md'}, [
        h('div', {class: 'col-12 col-md-5'}, [
          h(QCard, {dark: true, class: 'panel q-pa-md'}, () => [
            h('h2', {class: 'text-h6 text-weight-bold q-my-none q-mb-md'}, 'Settings'),
            h(QToggle, {
              modelValue: this.settings.enabled,
              'onUpdate:modelValue': value => {
                this.settings.enabled = value
              },
              label: 'Enable Battleships games',
              color: 'primary'
            }),
            h('div', {class: 'row q-col-gutter-sm q-mt-xs'}, [
              h('div', {class: 'col-12'}, [
                h(QSelect, {
                  modelValue: this.effectiveWalletId,
                  'onUpdate:modelValue': value => {
                    this.settings.walletId = value
                  },
                  options: this.wallets.map(wallet => ({
                    label: wallet.name || wallet.id,
                    value: wallet.id
                  })),
                  emitValue: true,
                  mapOptions: true,
                  filled: true,
                  dense: true,
                  dark: true,
                  label: 'Wallet',
                  disable: !this.wallets.length,
                  hint: this.wallets.length ? 'Receives entries and pays winners.' : 'Create a wallet before enabling Battleships games.'
                })
              ]),
              h('div', {class: 'col-12 col-sm-6'}, [
                settingsInput('haircut', {type: 'number', min: 0, max: 100, label: 'Haircut %'})
              ])
            ]),
            h(QBtn, {
              class: 'q-mt-md',
              color: 'primary',
              loading: this.saving,
              disable: !this.canSave,
              onClick: this.saveSettings
            }, () => 'Save Settings')
          ]),

          h(QCard, {dark: true, class: 'panel q-pa-md q-mt-md'}, () => [
            h('h2', {class: 'text-h6 text-weight-bold q-my-none q-mb-md'}, 'New Game'),
            gameInput('name', {label: 'Title'}, value => String(value || '').trim()),
            gameInput('joinAmount', {type: 'number', min: MIN_JOIN_SATS, label: 'Join sats (minimum 20)', class: 'q-mt-sm'}, Number),
            h(QBtn, {
              class: 'q-mt-md',
              color: 'primary',
              loading: this.creating,
              disable: !this.canCreate,
              onClick: this.createGame
            }, () => 'Create Game')
          ])
        ]),

        h('div', {class: 'col-12 col-md-7'}, [
          h(QCard, {dark: true, class: 'panel q-pa-md'}, () => [
            h('div', {class: 'row items-center q-col-gutter-sm q-mb-md'}, [
              h('div', {class: 'col'}, [
                h('h2', {class: 'text-h6 text-weight-bold q-my-none'}, 'Games')
              ]),
              h('div', {class: 'col-auto'}, [
                h(QBtn, {
                  outline: true,
                  color: 'primary',
                  label: 'Authorize Payments',
                  loading: this.authorizingPayments,
                  disable: !this.canAuthorizePayments,
                  onClick: this.authorizePayments
                })
              ]),
              h('div', {class: 'col-12 col-sm-5'}, [
                h(QInput, {
                  modelValue: this.search,
                  'onUpdate:modelValue': value => {
                    this.search = value
                  },
                  debounce: 300,
                  filled: true,
                  dense: true,
                  dark: true,
                  clearable: true,
                  label: 'Search',
                  onClear: () => {
                    this.search = ''
                    this.fetchGames()
                  },
                  onKeyup: event => {
                    if (event.key === 'Enter') this.fetchGames()
                  }
                })
              ])
            ]),
            h(QTable, {
              dark: true,
              flat: true,
              rows: this.games,
              columns: this.columns,
              rowKey: 'id',
              loading: this.loading,
              pagination: this.pagination,
              'onUpdate:pagination': value => {
                this.pagination = value
              },
              onRequest: this.fetchGames
            }, {
              'body-cell-players': props =>
                h(QTd, {props}, () => `${props.row.playersCount} / 2`),
              'body-cell-status': props =>
                h(QTd, {props}, () =>
                  h(QBadge, {
                    color: props.row.status === 'completed' ? 'positive' : ['active', 'placing'].includes(props.row.status) ? 'primary' : 'grey'
                  }, () => this.statusLabel(props.row))
                ),
              'body-cell-winner': props =>
                h(QTd, {props}, () => props.row.winnerLnAddress || ''),
              'body-cell-actions': props =>
                h(QTd, {props, class: 'text-right'}, () => [
                  h(QBtn, {
                    dense: true,
                    round: true,
                    flat: true,
                    icon: 'content_copy',
                    onClick: () => this.copyGame(props.row)
                  }, () => h(QTooltip, () => 'Copy public link')),
                  h(QBtn, {
                    dense: true,
                    round: true,
                    flat: true,
                    color: 'negative',
                    icon: 'delete',
                    loading: this.deletingGameId === props.row.id,
                    disable: props.row.status === 'completed' && props.row.payoutPending,
                    onClick: () => this.deleteGame(props.row)
                  }, () => h(QTooltip, () =>
                    props.row.status === 'completed' && props.row.payoutPending
                      ? 'Settle payout before deleting'
                      : 'Delete game'
                  )),
                  props.row.status === 'completed' && props.row.payoutPending
                    ? h(QBtn, {
                        dense: true,
                        round: true,
                        flat: true,
                        color: 'primary',
                        icon: 'payments',
                        onClick: () => this.settleGame(props.row)
                      }, () => h(QTooltip, () => 'Pay winner'))
                    : null
                ])
            })
          ])
        ])
      ])
    ])
  }
})

app.use(Quasar)
app.mount('#battleships-admin-app')
