// esdoc plugin to add valid line-breaks to documentation
//  otherwise need double new-lines to get anything to output correctly
module.exports = {
  onHandleDocs(event) {
    event.data.docs.forEach((doc) => {
      if (!!doc.description) {
        // replace newline characters with HTML breaks
        doc.description = doc.description.replace(/(?:\r\n|\r|\n)/g, '<br />');
      }
    });
  },
};
