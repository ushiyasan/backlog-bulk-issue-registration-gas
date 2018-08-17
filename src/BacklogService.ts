import UiInstance = GoogleAppsScript.UI.UiInstance
import {BacklogClient, BacklogClientImpl, GoogleAppsScriptDateFormatter} from "./BacklogClient"
import {Key, Project, Issue, Id, BacklogDefinition, Locale, UserProperty, User} from "./datas"
import {HttpClient} from "./Http"
import {Option, Some, None} from "./Option"
import {Either, Right, Left} from "./Either"
import {IssueConverter} from "./IssueConverter"
import {List} from "./List"
import {Message} from "./resources"
import {SpreadSheetService, SpreadSheetServiceImpl} from "./SpreadSheetService"

const SCRIPT_VERSION = "v2.0.3-SNAPSHOT"
const TEMPLATE_SHEET_NAME = "Template"
const ROW_HEADER_INDEX = 1
const COLUMN_START_INDEX = 1 /** データ列の開始インデックス */
const ROW_START_INDEX = 2    /** データ行の開始インデックス */
const DEFAULT_COLUMN_LENGTH = 16

type Validation<A> = (a: A, onError: Error) => Either<Error, A>

const isEmpty: Validation<string> = (str: string, onError: Error): Either<Error, string> =>
  str !== "" ? Right(str) : Left(onError)

const createBacklogClient = (space: string, domain: string, apiKey: string, locale: Locale): Either<Error, BacklogClient> => {
  const spaceResult = isEmpty(space, Error(Message.SPACE_URL_REQUIRED(locale)))
  const apiKeyResult = isEmpty(apiKey, Error(Message.API_KEY_REQUIRED(locale)))
  return Either.map2(spaceResult, apiKeyResult, (s, a) => {
    return Right(new BacklogClientImpl(new HttpClient, s, domain, a, new GoogleAppsScriptDateFormatter))
  })
}

export const getProject = (client: BacklogClient, key: Key<Project>, locale: Locale): Either<Error, Project> => {
  const validationResult = isEmpty(key, Error(Message.PROJECT_KEY_REQUIRED(locale)))
  const clientResult = client.getProjectV2(key).recover(error => {
    if (error.message.indexOf("returned code 404") !== -1)
      return Left(Error(Message.SPACE_OR_PROJECT_NOT_FOUND(locale)))
    if (error.message.indexOf("returned code 401") !== -1)
      return Left(Error(Message.AUTHENTICATE_FAILED(locale)))
    return Left(Error(Message.API_ACCESS_ERROR(error, locale)))
  })

  return Either.map2(validationResult, clientResult, (_, project) => Right(project))
}

const createIssueConverter = (client: BacklogClient, projectId: Id<Project>): IssueConverter =>
  IssueConverter(
    projectId,
    client.getIssueTypesV2(projectId),
    client.getCategoriesV2(projectId),
    client.getVersionsV2(projectId),
    client.getPrioritiesV2(),
    client.getUsersV2(projectId),
    client.getCustomFieldsV2(projectId)
  )

const convertIssue = (converter: IssueConverter, issue: any): Either<Error, Issue> =>
  converter.convert(issue)

const validate = (issues: List<any>, client: BacklogClient, locale: Locale): Either<Error, boolean> => {
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i]
    const errorString = Message.VALIDATE_ERROR_LINE(i + 2, locale)
    if (!Option(issue.summary).isDefined)
      return Left(Error(errorString + Message.VALIDATE_SUMMARY_EMPTY(locale)))
    if (!Option(issue.issueTypeName).isDefined)
      return Left(Error(errorString + Message.VALIDATE_ISSUE_TYPE_EMPTY(locale)))
    if (issue.parentIssueKey !== undefined && issue.parentIssueKey !== "*")
      if (!client.getIssueV2(issue.parentIssueKey).isDefined)
        return Left(Error(errorString + Message.VALIDATE_PARENT_ISSUE_KEY_NOT_FOUND(issue.parentIssueKey, locale)))
  }
  return Right(true)
}

const getMessage = (key: string, spreadSheetService: SpreadSheetService) =>
  Message.findByKey(key, spreadSheetService.getUserLocale())

const getUserProperties = (spreadSheetService: SpreadSheetService): UserProperty => {
  const lastSpace = spreadSheetService.getUserProperty("space") ? spreadSheetService.getUserProperty("space") : ""
  const lastDomain = spreadSheetService.getUserProperty("domain") ? spreadSheetService.getUserProperty("domain") : ".com"
  const lastApiKey = spreadSheetService.getUserProperty("apiKey") ? spreadSheetService.getUserProperty("apiKey") : ""
  const lastProjectKey = spreadSheetService.getUserProperty("projectKey") ? spreadSheetService.getUserProperty("projectKey") : ""

  return UserProperty(lastSpace, lastDomain, lastApiKey, lastProjectKey)
}

const storeUserProperties = (grid: any, spreadSheetService: SpreadSheetService): void => {
  spreadSheetService.setUserProperty("space", grid.parameter.space)
  spreadSheetService.setUserProperty("domain", grid.parameter.domain)
  spreadSheetService.setUserProperty("apiKey", grid.parameter.apiKey)
  spreadSheetService.setUserProperty("projectKey", grid.parameter.projectKey)
}

const showMessage = (message: string, spreadSheetService: SpreadSheetService): void =>
  spreadSheetService.showMessage(getMessage("scriptName", spreadSheetService), message)

const strLength = (text: string): number => {
  let count = 0

  for (let i = 0; i < text.length; i++) {
    const n = escape(text.charAt(i))
    if (n.length < 4)
      count += 1
    else
      count += 2
  }
  return count
}

const createIssue = (client: BacklogClient, issue: Issue, optParentIssueId: Option<string>): Either<Error, Issue> => {
  const createIssue = Issue(
    0,
    "",
    issue.projectId,
    issue.summary,
    issue.description,
    issue.startDate,
    issue.dueDate,
    issue.estimatedHours,
    issue.actualHours,
    issue.issueType,
    issue.categories,
    issue.versions,
    issue.milestones,
    issue.priority,
    issue.assignee,
    optParentIssueId.map(id => id.toString()),
    issue.customFields
  )

  return client.createIssueV2(createIssue)
}

const getTemplateIssuesFromSpreadSheet = (spreadSheetService: SpreadSheetService): any => {
  let issues = []
  const spreadSheet = SpreadsheetApp.getActiveSpreadsheet()
  const sheet = spreadSheet.getSheetByName(TEMPLATE_SHEET_NAME)
  const columnLength = sheet.getLastColumn()
  const values = sheet.getSheetValues(
    ROW_START_INDEX,
    COLUMN_START_INDEX,
    sheet.getLastRow() - 1,
    columnLength
  )

  for (let i = 0; i < values.length; i++) {
    let customFields = []
    let customFieldIndex = 0
    for (let j = 13; j < columnLength; j++) {
      if (values[i][j] !== "") {
        customFields[customFieldIndex] = {
          header: spreadSheetService.getRange(sheet, j + 1, ROW_HEADER_INDEX).getFormula(),
          value: values[i][j]
        }
        customFieldIndex++
      }
    }
    const issue = {
      summary: values[i][0] === "" ? undefined : values[i][0],
      description: values[i][1] === "" ? undefined : values[i][1],
      startDate: values[i][2] === "" ? undefined : values[i][2],
      dueDate: values[i][3] === "" ? undefined : values[i][3],
      estimatedHours: values[i][4] === "" ? undefined : values[i][4],
      actualHours: values[i][5] === "" ? undefined : values[i][5],
      issueTypeName: values[i][6] === "" ? undefined : values[i][6],
      categoryNames: values[i][7],
      versionNames: values[i][8],
      milestoneNames: values[i][9],
      priorityName: values[i][10] === "" ? undefined : values[i][10],
      assigneeName: values[i][11] === "" ? undefined : values[i][11],
      parentIssueKey: values[i][12] === "" ? undefined : values[i][12],
      customFields: customFields
    }
    issues[i] = issue
  }
  return issues
}

const calcWidth = (length: number): number => {
  const DEFAULT_FONT_SIZE = 10 	/** フォントのデフォルトサイズ */
  const ADJUST_WIDTH_FACTOR = 0.75 /** 列幅調整時の係数 */
  return length * DEFAULT_FONT_SIZE * ADJUST_WIDTH_FACTOR
}

interface BacklogService {

  createApplication: (title: string, width: number, height: number) => UiInstance

  createGrid: (ui: UiInstance, property: UserProperty) => any

  showDialog: (ui: UiInstance, grid: any, handlerName: string) => void

  showInitDialog: () => void

  showRunDialog: () => void

  getUserProperties: () => UserProperty

  storeUserProperties: (grid: any) => void

  run: (grid: any) => UiInstance

  getDefinitions: (grid: any) => UiInstance

  getMessage: (key: string, locale: string) => string

  showMessage: (message: string) => void
}

export const BacklogService = (spreadSheetService: SpreadSheetService): BacklogService => ({

  createApplication: (title: string, width: number, height: number): UiInstance =>
    UiApp
      .createApplication()
      .setTitle(title)
      .setWidth(width)
      .setHeight(height),

  createGrid: (ui: UiInstance, property: UserProperty): any => {
    const anotherDomain = (property.domain === ".com") ? ".jp" : ".com"
    return ui
      .createGrid(3, 4)
      .setWidget(0, 0, ui.createLabel(getMessage("label_spaceId", spreadSheetService)))
      .setWidget(0, 1, ui.createTextBox().setName("space").setValue(property.space))
      .setWidget(0, 2, ui.createLabel(".backlog"))
      .setWidget(0, 3, ui.createListBox(false).setName("domain").addItem(property.domain).addItem(anotherDomain))
      .setWidget(1, 0, ui.createLabel(getMessage("label_apiKey", spreadSheetService)))
      .setWidget(1, 1, ui.createTextBox().setName("apiKey").setValue(property.apiKey))
      .setWidget(2, 0, ui.createLabel(getMessage("label_projectKey", spreadSheetService)))
      .setWidget(2, 1, ui.createTextBox().setName("projectKey").setValue(property.projectKey))
  },

  showDialog(ui: UiInstance, grid: any, handlerName: string): void {
    const panel = ui.createVerticalPanel()
    const submitButton = ui.createButton(getMessage("button_execute", spreadSheetService))
    const submitHandler = ui.createServerClickHandler(handlerName)

    submitHandler.addCallbackElement(grid)
    submitButton.addClickHandler(submitHandler)
    panel.add(grid).add(submitButton)
    ui.add(panel)
    SpreadsheetApp.getActiveSpreadsheet().show(ui)
  },

  showInitDialog(): void {
    const app = this.createApplication(getMessage("title_init", spreadSheetService) + " " + SCRIPT_VERSION, 360, 160)
    const property = this.getUserProperties()
    const grid = this.createGrid(app, property)

    this.showDialog(app, grid, "init")
  },

  showRunDialog(): void {
    const app = this.createApplication(getMessage("title_run", spreadSheetService) + " " + SCRIPT_VERSION, 360, 160)
    const property = this.getUserProperties()
    const grid = this.createGrid(app, property)

    this.showDialog(app, grid, "main")
  },

  getUserProperties: (): UserProperty =>
    getUserProperties(spreadSheetService),

  storeUserProperties: (grid: any): void =>
    storeUserProperties(grid, spreadSheetService),

  run: (grid: any): UiInstance => {
    const app = UiApp.getActiveApplication()
    const property = getUserProperties(spreadSheetService)
    const current = Utilities.formatDate(new Date(), "JST", "yyyy/MM/dd HH:mm:ss")
    const sheetName = getMessage("scriptName", spreadSheetService) + " : " + current
    const LOG_KEY_NUMBER = 1
    const LOG_SUMMARY_NUMBER = 2
    const locale = spreadSheetService.getUserLocale()

    // BacklogScript throws an exception on error
    showMessage(getMessage("progress_collect", spreadSheetService), spreadSheetService)
    const templateIssues = getTemplateIssuesFromSpreadSheet(spreadSheetService)
    storeUserProperties(grid, spreadSheetService)
    showMessage(Message.PROGRESS_RUN_BEGIN(locale), spreadSheetService)

    const client = createBacklogClient(property.space, property.domain, property.apiKey, locale).getOrError()
    const _ = validate(templateIssues, client, locale).getOrError()
    const project = getProject(client, property.projectKey, locale).getOrError()
    const converter = createIssueConverter(client, project.id)
    const convertResults = templateIssues.map(issue => convertIssue(converter, issue))
    const issues = Either.sequence(convertResults).getOrError()

    // Post issues
    let previousIssue = Option<Issue>(null)
    let keyLength = DEFAULT_COLUMN_LENGTH
    let summaryLength = DEFAULT_COLUMN_LENGTH

    for ( let i = 0; i < issues.length; i++) {
      let isTakenOverParentIssueId = false
      let optParentIssueId = issues[i].parentIssueId

      optParentIssueId.map(function(parentIssueId) {
        if (parentIssueId === "*") {
          if (previousIssue.flatMap(issue => issue.parentIssueId).isDefined) {
            previousIssue.map(issue => showMessage(Message.ALREADY_BEEN_CHILD_ISSUE(issue.issueKey, locale), spreadSheetService))
            optParentIssueId = None<string>()
          } else {
            optParentIssueId = previousIssue.map(issue => issue.id.toString())
            isTakenOverParentIssueId = true
          }
        } else {
          optParentIssueId = client.getIssueV2(parentIssueId).map(issue => issue.id)
        }
      })
      createIssue(client, issues[i], optParentIssueId.map(id => id)).map(issue => {
        if (!isTakenOverParentIssueId) {
          previousIssue = Some(issue)
        }
        let logSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName)
        const issueKey = issue.issueKey
        const summary = issue.summary
        const fomula = "=hyperlink(\"" + property.space + ".backlog" + property.domain + "/" + "view/" + issueKey + "\";\"" + issueKey + "\")"
        const currentRow = i + 1

        if (logSheet == null)
          logSheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet(sheetName, 1)
        keyLength = Math.max(keyLength, strLength(issueKey))
        summaryLength = Math.max(summaryLength, strLength(summary))

        const keyWidth = calcWidth(keyLength)
        const summaryWidth = calcWidth(summaryLength)
        const keyCell = spreadSheetService.getRange(logSheet, LOG_KEY_NUMBER, currentRow)
        const summaryCell = spreadSheetService.getRange(logSheet, LOG_SUMMARY_NUMBER, currentRow)

        keyCell.setFormula(fomula).setFontColor("blue").setFontLine("underline")
        summaryCell.setValue(summary)
        spreadSheetService.setColumnWidth(logSheet, LOG_KEY_NUMBER, keyWidth)
        spreadSheetService.setColumnWidth(logSheet, LOG_SUMMARY_NUMBER, summaryWidth)
        SpreadsheetApp.flush()
      }).getOrError()
    }
    showMessage(getMessage("scriptName", spreadSheetService) + getMessage("progress_end", spreadSheetService), spreadSheetService)
    return app.close()
  },

  getDefinitions: (grid: any): UiInstance => {
    storeUserProperties(grid, spreadSheetService)
    const app = UiApp.getActiveApplication()
    const property = getUserProperties(spreadSheetService)
    const locale = spreadSheetService.getUserLocale()

    showMessage(Message.PROGRESS_INIT_BEGIN(locale), spreadSheetService)
    return createBacklogClient(property.space, property.domain, property.apiKey, locale)
      .flatMap(client =>
        getProject(client, property.projectKey, locale).map(project =>
          BacklogDefinition(
            client.getIssueTypesV2(project.id),
            client.getCategoriesV2(project.id),
            client.getVersionsV2(project.id),
            client.getPrioritiesV2(),
            client.getUsersV2(project.id),
            client.getCustomFieldsV2(project.id)
          )
        )
      )
      .map(definition => {
        const templateSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TEMPLATE_SHEET_NAME)
        const issueTypeRule = SpreadsheetApp.newDataValidation().requireValueInList(definition.issueTypeNames(), true).build()
        const categoryRule = SpreadsheetApp.newDataValidation().requireValueInList(definition.categoryNames(), true).build()
        const versionRule = SpreadsheetApp.newDataValidation().requireValueInList(definition.versionNames(), true).build()
        const priorityRule = SpreadsheetApp.newDataValidation().requireValueInList(definition.priorityNames(), true).build()
        const userRule = SpreadsheetApp.newDataValidation().requireValueInList(definition.userNames(), true).build()
        const lastRowNumber = templateSheet.getLastRow() - 1
        const customFieldStartColumnNumber = 14 // N ~
        let currentColumnNumber = customFieldStartColumnNumber

        templateSheet.getRange(2, 7, lastRowNumber).setDataValidation(issueTypeRule)  // 7 = G
        templateSheet.getRange(2, 8, lastRowNumber).setDataValidation(categoryRule) 	// 8 = H
        templateSheet.getRange(2, 9, lastRowNumber).setDataValidation(versionRule) 	  // 9 = I
        templateSheet.getRange(2, 10, lastRowNumber).setDataValidation(versionRule) 	// 10 = J
        templateSheet.getRange(2, 11, lastRowNumber).setDataValidation(priorityRule)  // 11 = K
        templateSheet.getRange(2, 12, lastRowNumber).setDataValidation(userRule) 	    // 12 = L
        for (let i = 0; i < definition.customFields.length; i++) {
          const customField = definition.customFields[i]
          const headerCell = spreadSheetService.getRange(templateSheet, currentColumnNumber, ROW_HEADER_INDEX)
          const columnName = headerCell.getValue()

          /**
           * https://github.com/nulab/backlog4j/blob/master/src/main/java/com/nulabinc/backlog4j/CustomField.java#L10
           * Text(1), TextArea(2), Numeric(3), Date(4), SingleList(5), MultipleList(6), CheckBox(7), Radio(8)
           * We don't support the types MultipleList(6) and CheckBox(7), Radio(8)
           */
          let customFieldName = ""

          if (customField.typeId >= 6)
            continue
          switch (customField.typeId) {
            case 1:
              customFieldName = "文字列"
              break
            case 2:
              customFieldName = "文章"
              break
            case 3:
              customFieldName = "数値"
              break
            case 4:
              customFieldName = "日付"
              break
            case 5:
              customFieldName = "選択リスト"
              break
          }

          const headerName = customField.name + "（" + customFieldName + "）"

          if (columnName === "") {
            const headerStrLength = strLength(headerName)
            const headerWidth = calcWidth(headerStrLength)

            templateSheet.insertColumnAfter(currentColumnNumber - 1)
            templateSheet
              .getRange(1, currentColumnNumber, templateSheet.getLastRow(), 1)
              .setBackground("#F8FFFF")
              .setFontColor("black")
            spreadSheetService.setColumnWidth(templateSheet, currentColumnNumber, headerWidth)
          }
          headerCell.setFormula(
            "=hyperlink(\"" + property.space + ".backlog" + property.domain + "/EditAttribute.action?attribute.id=" + customField.id + "\";\"" + headerName + "\")"
          )
          currentColumnNumber++
        }
        // Data validation must be added after all column insert
        for (let i = 0; i < definition.customFields.length; i++) {
          const customField = definition.customFields[i]
          if (customField.typeId === 5) {
            definition.customFieldItemNames(customField).map(itemNames => {
              const itemRule = SpreadsheetApp.newDataValidation().requireValueInList(itemNames, true).build()
              templateSheet.getRange(2, i + customFieldStartColumnNumber, lastRowNumber).setDataValidation(itemRule)
            })
          }
        }
        showMessage(getMessage("complete_init", spreadSheetService), spreadSheetService)
        return app.close()
      })
      .getOrError()
  },

  getMessage: (key: string): string =>
    getMessage(key, spreadSheetService),

  showMessage: (message: string): void =>
    showMessage(message, spreadSheetService)
})
